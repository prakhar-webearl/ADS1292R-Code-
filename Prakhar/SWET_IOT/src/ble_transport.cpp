/**
 * ble_transport.cpp
 * -----------------------------------------------------------
 * BLE Transport — Raw Binary ECG Data + JSON Status Push
 *
 * TWO characteristics on the same service:
 *
 * ① ECG Data Characteristic  (NOTIFY | READ)
 *   UUID: ...abcdef1
 *   508-byte raw binary packet per block. No chunking needed.
 *
 * ② Status Characteristic  (NOTIFY | READ)
 *   UUID: ...abcdef2
 *   Plain JSON strings pushed by the ESP whenever WiFi state changes.
 *   The mobile app subscribes here to know when WiFi connects OK.
 *   Examples:
 *     {"status":"wifi_connecting"}
 *     {"status":"wifi_connected","ip":"192.168.1.10","deviceId":"ESP_ECG_123"}
 *     {"status":"wifi_failed"}
 *     {"status":"wifi_disconnected"}
 *     {"status":"ble_connected"}
 *
 * AUTO-CONNECT STRATEGY & PRIORITY:
 *   If the device was last connected via BLE, network.cpp defers starting
 *   the WiFi AP and STA. ble_init() will start "Directed Advertising"
 *   to the last connected phone. The phone OS wakes up and connects
 *   automatically (even if the app is closed), WITHOUT the peer appearing
 *   in the device's paired list.
 *   If no connection within 30 seconds, we fall back to network_startIdleMode()
 *   so the WiFi AP/STA start up, and BLE switches to general advertising.
 *
 * PACKET LAYOUT — ECG characteristic (508 bytes, little-endian, packed):
 *   [0..3]   uint32_t  seq
 *   [4]      uint8_t   sampleRate  = 125
 *   [5]      uint8_t   flags       bit0=lo, bit1=loPlus, bit2=loMinus
 *   [6]      uint8_t   severity    0=INFO, 1=WARNING, 2=CRITICAL
 *   [7]      uint8_t   numSamples  = 125
 *   [8..507] int32_t   samples[125]
 * -----------------------------------------------------------
 */

#include "config.h"
#include "network.h"
#include <Arduino.h>
#include <NimBLEDevice.h>
#include <Preferences.h>

// ── UUIDs
// ─────────────────────────────────────────────────────────────────────
#define BLE_DEVICE_NAME "ECG_Setup"
#define SERVICE_UUID "12345678-1234-5678-1234-56789abcdef0"
#define ECG_CHAR_UUID "12345678-1234-5678-1234-56789abcdef1" // Raw ECG binary
#define STATUS_CHAR_UUID "12345678-1234-5678-1234-56789abcdef2" // JSON status push

// ── Severity constants
// ────────────────────────────────────────────────────────
#define SEV_INFO 0
#define SEV_WARNING 1
#define SEV_CRITICAL 2

// ── NVS namespace for BLE peer storage ───────────────────────────────────────
#define BLE_NVS_NS     "ble_peer"
#define BLE_NVS_KEY    "peer_mac"    // stores "AA:BB:CC:DD:EE:FF" (17 chars)

// ── Directed advertising: try for 30 s before falling back to general ─────────
#define DIRECTED_ADV_TIMEOUT_MS  30000UL


// ── Raw binary packet (ECG data)
// ──────────────────────────────────────────────
struct __attribute__((packed)) BleRawPacket {
  uint32_t seq;
  uint8_t sampleRate;           // 125 Hz
  uint8_t flags;                // bit0=lo, bit1=loPlus, bit2=loMinus
  uint8_t severity;             // SEV_INFO / SEV_WARNING / SEV_CRITICAL
  uint8_t numSamples;           // 125
  int32_t samples[WINDOW_SIZE]; // raw signed ADC values
};
static_assert(sizeof(BleRawPacket) == 8 + WINDOW_SIZE * 4,
              "BleRawPacket size mismatch");

// ── Forward declarations
// ──────────────────────────────────────────────────────
static uint8_t parseSeverity(const char *s);
static void    savePeerMac(const NimBLEAddress& addr);
static bool    loadPeerMac(NimBLEAddress& out);
static void    startDirectedAdv();
static void    startGeneralAdv();
void           ble_sendStatus(const String &json);

// ── NimBLE handles
// ────────────────────────────────────────────────────────────
static NimBLEServer *pServer = nullptr;
static NimBLEService *pService = nullptr;
static NimBLECharacteristic *pEcgChar = nullptr;    // ECG binary data
static NimBLECharacteristic *pStatusChar = nullptr; // JSON status push

static bool s_bleConnected = false;
static uint16_t s_bleMtu = 23;
static bool s_needReadvertise = false; // set by onDisconnect, acted on by ble_update()

// ── Peer MAC persistence ──────────────────────────────────────────────────────
static char     s_peerMacStr[18]  = {0};     // "AA:BB:CC:DD:EE:FF"
static bool     s_hasPeerMac      = false;

// ── Directed advertising timer ────────────────────────────────────────────────
static bool     s_inDirectedAdv   = false;
static uint32_t s_directedAdvStartMs = 0;

// ── Server Callbacks
// ──────────────────────────────────────────────────────────
class BleServerCallbacks : public NimBLEServerCallbacks {

  void onConnect(NimBLEServer *pSrv, ble_gap_conn_desc *desc) override {
    s_bleConnected = true;
    s_inDirectedAdv = false;

    NimBLEAddress peerAddr(desc->peer_ota_addr);
    String macStr = peerAddr.toString().c_str();
    macStr.toUpperCase();

    Serial.printf("[BLE] Client connected! MAC: %s\n", macStr.c_str());

    // Save peer MAC to NVS for future directed advertising
    savePeerMac(peerAddr);

    // Save priority to BLE
    Preferences prefs;
    prefs.begin(NVS_NAMESPACE, false);
    prefs.putString("last_mode", "ble");
    prefs.end();

    // Push a "ble_connected" status immediately so the app knows the link is up.
    String status = "{\"status\":\"ble_connected\",\"mac\":\"" + macStr + "\"}";
    ble_sendStatus(status);
  }

  void onDisconnect(NimBLEServer *pSrv) override {
    s_bleConnected = false;
    s_bleMtu = 23;
    Serial.println(F("[BLE] Client disconnected."));

    // DO NOT call NimBLEDevice::startAdvertising() here directly.
    s_needReadvertise = true;
  }

  void onMTUChange(uint16_t mtu, ble_gap_conn_desc *desc) override {
    s_bleMtu = mtu;
    Serial.printf(
        "[BLE] MTU negotiated: %u bytes  |  ECG packet %u bytes  |  fits: %s\n",
        mtu, (unsigned)sizeof(BleRawPacket),
        (mtu - 3 >= (int)sizeof(BleRawPacket)) ? "YES (1 notif)" : "NO (partial)");
  }
};

// ── Security Callbacks ────────────────────────────────────────────────────────
class BleSecurityCallbacks : public NimBLESecurityCallbacks {
  uint32_t onPassKeyRequest() override { return 123456; }
  void onPassKeyNotify(uint32_t k) override { (void)k; }
  bool onConfirmPIN(uint32_t k) override { return true; }
  bool onSecurityRequest() override { return true; }
  
  void onAuthenticationComplete(ble_gap_conn_desc *desc) override {
    if (desc->sec_state.encrypted) {
      Serial.println(F("[BLE] Auth OK — link encrypted."));
      return;
    }
    
    // Key mismatch: ESP32 rebooted (new keys), phone has old keys.
    // Solution: delete stale bond, disconnect, phone will re-pair.
    NimBLEAddress peer(desc->peer_ota_addr);
    Serial.printf("[BLE] Auth FAILED for %s — deleting stale bond.\n",
                  peer.toString().c_str());
    NimBLEDevice::deleteBond(peer);
    pServer->disconnect(desc->conn_handle);
  }
};

// ── Public API
// ────────────────────────────────────────────────────────────────
bool ble_isConnected() { return s_bleConnected; }
uint16_t ble_getMtu() { return s_bleMtu; }
bool ble_isPriorityAdv() { return s_inDirectedAdv; }

// ── ble_init()
// ────────────────────────────────────────────────────────────────
void ble_init() {
  Serial.println(F("[BLE] Initializing NimBLE (priority reconnect + persistence)..."));

  // Load previously stored peer MAC
  NimBLEAddress storedAddr("00:00:00:00:00:00");
  if (loadPeerMac(storedAddr)) {
    s_hasPeerMac = true;
    Serial.printf("[BLE] Stored peer MAC: %s\n", s_peerMacStr);
  }

  NimBLEDevice::init(BLE_DEVICE_NAME);
  NimBLEDevice::setMTU(517);

  // Bonding MUST be enabled for auto-reconnect on OS level
  NimBLEDevice::setSecurityAuth(true, false, true);
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);
  NimBLEDevice::setSecurityCallbacks(new BleSecurityCallbacks());

  pServer = NimBLEDevice::createServer();
  pServer->setCallbacks(new BleServerCallbacks());

  pService = pServer->createService(SERVICE_UUID);

  pEcgChar = pService->createCharacteristic(
      ECG_CHAR_UUID, NIMBLE_PROPERTY::NOTIFY | NIMBLE_PROPERTY::READ);

  pStatusChar = pService->createCharacteristic(
      STATUS_CHAR_UUID, NIMBLE_PROPERTY::NOTIFY | NIMBLE_PROPERTY::READ);

  pService->start();

  // Determine if we should do directed advertising (if BLE had priority)
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, true);
  String lastMode = prefs.getString("last_mode", "");
  prefs.end();

  if (lastMode == "ble" && s_hasPeerMac) {
    startDirectedAdv();
  } else {
    startGeneralAdv();
  }

  Serial.printf("[BLE] ECG pkt size : %u bytes\n", (unsigned)sizeof(BleRawPacket));
}

void ble_startAdvertising() { startGeneralAdv(); }
void ble_stopAdvertising() { NimBLEDevice::stopAdvertising(); }

// ── ble_update()
// ──────────────────────────────────────────────────────────────
void ble_update() {
  if (s_needReadvertise && !s_bleConnected) {
    s_needReadvertise = false;
    if (s_hasPeerMac) {
      Serial.println(F("[BLE] Restarting directed advertising to stored peer."));
      startDirectedAdv();
    } else {
      Serial.println(F("[BLE] Restarting general advertising."));
      startGeneralAdv();
    }
  }

  // Handle directed advertising timeout -> switch to Idle Mode
  if (s_inDirectedAdv && !s_bleConnected) {
    uint32_t elapsed = millis() - s_directedAdvStartMs;
    if (elapsed >= DIRECTED_ADV_TIMEOUT_MS) {
      s_inDirectedAdv = false;
      Serial.println(F("[BLE] Directed adv timeout — switching to Idle Mode (general adv + WiFi fallback)."));
      // We call network_startIdleMode to boot up the WiFi logic that was deferred,
      // and it will also call ble_startAdvertising() to switch to general adv.
      network_startIdleMode();
    }
  }
}

// Push a plain JSON string to the Status characteristic.
void ble_sendStatus(const String &json) {
  if (!pStatusChar) return;
  pStatusChar->setValue((uint8_t *)json.c_str(), json.length());

  if (s_bleConnected) {
    pStatusChar->notify();
    Serial.println("[BLE] Status push: " + json);
  }
}

// ── ble_uploadBlock()
// ───────────────────────────────────────────────────────── 
void ble_uploadBlock(const Block &blk, bool leadsOff, bool loPlus, bool loMinus,
                     const char *warning, const char *severity) {
  if (!s_bleConnected || !pEcgChar) return;

  size_t packetSize = sizeof(BleRawPacket);
  size_t maxPayload = (size_t)(s_bleMtu > 3 ? s_bleMtu - 3 : 0);

  if (maxPayload < packetSize) {
    size_t maxSamples = (maxPayload > 8) ? (maxPayload - 8) / 4 : 0;
    if (maxSamples == 0) return;

    uint8_t buf[512];
    uint32_t seq = blk.seq;
    uint8_t sr = (uint8_t)SAMPLE_RATE;
    uint8_t fl =
        (leadsOff ? 0x01 : 0) | (loPlus ? 0x02 : 0) | (loMinus ? 0x04 : 0);
    uint8_t sev = parseSeverity(severity);
    uint8_t ns = (uint8_t)maxSamples;
    memcpy(buf + 0, &seq, 4);
    memcpy(buf + 4, &sr, 1);
    memcpy(buf + 5, &fl, 1);
    memcpy(buf + 6, &sev, 1);
    memcpy(buf + 7, &ns, 1);
    memcpy(buf + 8, blk.data, maxSamples * 4);
    pEcgChar->setValue(buf, 8 + maxSamples * 4);
    pEcgChar->notify();
    return;
  }

  BleRawPacket pkt;
  pkt.seq = blk.seq;
  pkt.sampleRate = (uint8_t)SAMPLE_RATE;
  pkt.numSamples = (uint8_t)WINDOW_SIZE;
  pkt.flags = (leadsOff ? 0x01 : 0) | (loPlus ? 0x02 : 0) | (loMinus ? 0x04 : 0);
  pkt.severity = parseSeverity(severity);
  memcpy(pkt.samples, blk.data, sizeof(int32_t) * WINDOW_SIZE);

  pEcgChar->setValue((uint8_t *)&pkt, sizeof(BleRawPacket));
  pEcgChar->notify();
}

// ── Internal helpers ──────────────────────────────────────────────────────────

static void savePeerMac(const NimBLEAddress& addr) {
  String macStr = addr.toString().c_str();
  macStr.toUpperCase();
  s_hasPeerMac = true;
  macStr.toCharArray(s_peerMacStr, sizeof(s_peerMacStr));
  
  Preferences prefs;
  prefs.begin(BLE_NVS_NS, false);
  prefs.putString(BLE_NVS_KEY, macStr);
  prefs.end();
  Serial.printf("[BLE] Peer MAC saved: %s\n", s_peerMacStr);
}

static bool loadPeerMac(NimBLEAddress& out) {
  Preferences prefs;
  prefs.begin(BLE_NVS_NS, true);
  String stored = prefs.getString(BLE_NVS_KEY, "");
  prefs.end();

  if (stored.length() != 17) return false;
  stored.toCharArray(s_peerMacStr, sizeof(s_peerMacStr));
  out = NimBLEAddress(s_peerMacStr);
  return true;
}

static void startDirectedAdv() {
  NimBLEAdvertising* pAdv = NimBLEDevice::getAdvertising();
  pAdv->stop();

  // Using General Advertising instead of Directed Advertising.
  // Modern phones use randomized MAC addresses (RPA) which rotate every 15 mins.
  // Directed advertising to an old random MAC will be ignored by the phone.
  // General advertising allows the phone's OS to recognize the bonded ESP32
  // using the Identity Resolving Keys (IRK) exchanged during pairing and auto-connect.
  pAdv->setAdvertisementType(BLE_GAP_CONN_MODE_UND);
  pAdv->addServiceUUID(pService->getUUID());
  pAdv->setScanResponse(true);
  pAdv->setMinInterval(0x20);
  pAdv->setMaxInterval(0x40);

  s_inDirectedAdv = true;
  s_directedAdvStartMs = millis();

  NimBLEDevice::startAdvertising();
  Serial.printf("[BLE] Priority Adv (waiting 30s for %s before WiFi starts)\n", s_peerMacStr);
}

static void startGeneralAdv() {
  NimBLEAdvertising* pAdv = NimBLEDevice::getAdvertising();
  pAdv->stop();

  pAdv->setAdvertisementType(BLE_GAP_CONN_MODE_UND);
  pAdv->addServiceUUID(pService->getUUID());
  pAdv->setScanResponse(true);
  pAdv->setMinInterval(0x20);
  pAdv->setMaxInterval(0x40);

  s_inDirectedAdv = false;
  NimBLEDevice::startAdvertising();
  Serial.println(F("[BLE] General advertising started."));
}

static uint8_t parseSeverity(const char *s) {
  if (!s || s[0] == '\0') return SEV_INFO;
  if (strncmp(s, "CRITICAL", 8) == 0) return SEV_CRITICAL;
  if (strncmp(s, "WARNING", 7) == 0) return SEV_WARNING;
  return SEV_INFO;
}
