/**
 * network.cpp
 * -----------------------------------------------------------
 * WiFi AP+STA manager + HTTP upload queue (ADS1292R Edition)
 *
 * WiFi Behaviour (mirrors AD8232 v9.4 exactly):
 *  - On boot: loads saved credentials from NVS (Preferences).
 *  - Tries STA first. If it fails/no creds → starts AP "ECG_ADS1292R".
 *  - Blue LED (GPIO2) ON when STA is connected, OFF otherwise.
 *  - AP runs concurrently (WIFI_AP_STA) while STA reconnects.
 *  - When a client connects to AP and POSTs /wifi-config, AP stops
 *    and STA takes over — LED turns ON.
 *  - If STA drops: reconnects every 5s. If 3 fails → starts AP again.
 *  - AP is also force-started if STA is down for > 15s.
 *
 * Payload format (exact AD8232 v9.4 match — server expects this):
 * {
 *   "userId":   "ESP_ECG_123",
 *   "deviceId": "ESP_ECG_123",
 *   "seq":      <uint32>,
 *   "sr":       125,
 *   "lo":       false,
 *   "loPlus":   false,
 *   "loMinus":  false,
 *   "data":     [int32, int32, ...]   // 125 full-scale ADS1292R samples
 * }
 *
 * POST endpoint: https://ads1292r-code.onrender.com/api/ecg
 * (NOT /api/ecg/live/... — that is the SSE GET stream for Python)
 * -----------------------------------------------------------
 */

#include "network.h"
#include "config.h"
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include "types.h"

// -----------------------------------------------------------
// Upload queue payload
// -----------------------------------------------------------
struct UploadPayload {
    Block    blk;
    bool     leadsOff;
    bool     loPlus;
    bool     loMinus;
    char     warning[32];
    char     severity[32];
};

// -----------------------------------------------------------
// Module-level state
// -----------------------------------------------------------
static QueueHandle_t s_uploadQueue  = nullptr;
static WebServer     s_server(80);
static Preferences   s_prefs;

static bool     s_staConnected       = false;
static bool     s_apActive           = false;
static bool     s_setupApMode        = false;
static bool     s_reconnectEnabled   = false;
static bool     s_hasCredentials     = false;
static uint8_t  s_reconnectFails     = 0;
const  uint8_t  RECONNECT_FAIL_LIMIT = 3;

static String   s_savedSsid;
static String   s_savedPass;
static char     s_deviceId[MAX_DEVICE_ID_LEN];
static char     s_userId[MAX_DEVICE_ID_LEN];

static uint32_t s_lastReconnectMs  = 0;
static uint32_t s_staLostTimeMs    = 0;   // millis() when STA last dropped

// -----------------------------------------------------------
// Forward declarations
// -----------------------------------------------------------
static void uploadTask(void* pv);
static void buildJsonPayload(const UploadPayload& p, String& out);
static bool postPayload(const String& json);
static void startAP();
static bool connectSTA(const String& ssid, const String& pass, int retries = 20);
static void ledOn();
static void ledOff();
static void saveCredentials(const String& ssid, const String& pass);
static bool loadCredentials(String& ssid, String& pass);

// -----------------------------------------------------------
// LED helpers
// -----------------------------------------------------------
static void ledOn()  { digitalWrite(LED_PIN, HIGH); }
static void ledOff() { digitalWrite(LED_PIN, LOW);  }

// -----------------------------------------------------------
// Credentials (NVS)
// -----------------------------------------------------------
static void saveCredentials(const String& ssid, const String& pass) {
    s_prefs.begin(NVS_NAMESPACE, false);
    s_prefs.putString("wifi_ssid", ssid);
    s_prefs.putString("wifi_pass", pass);
    s_prefs.end();
    Serial.println("[NET] WiFi credentials saved to NVS.");
}

static bool loadCredentials(String& ssid, String& pass) {
    s_prefs.begin(NVS_NAMESPACE, true);
    ssid = s_prefs.getString("wifi_ssid", "");
    pass = s_prefs.getString("wifi_pass", "");
    s_prefs.end();
    return ssid.length() > 0;
}

static void loadIds() {
    s_prefs.begin(NVS_NAMESPACE, true);
    String did = s_prefs.getString("device_id", API_DEVICE_ID);
    String uid = s_prefs.getString("user_id",   API_USER_ID);
    s_prefs.end();
    did.toCharArray(s_deviceId, MAX_DEVICE_ID_LEN);
    uid.toCharArray(s_userId,   MAX_DEVICE_ID_LEN);
}
    
// -----------------------------------------------------------
// STA connect helper
// -----------------------------------------------------------
static bool connectSTA(const String& ssid, const String& pass, int retries) {
    WiFi.begin(ssid.c_str(), pass.c_str());
    for (int i = 0; i < retries; i++) {
        if (WiFi.status() == WL_CONNECTED) return true;
        delay(500);
    }
    return false;
}

// -----------------------------------------------------------
// AP mode
// -----------------------------------------------------------
static void startAP() {
    WiFi.disconnect(true, false);
    WiFi.softAPdisconnect(true);
    delay(50);
    WiFi.mode(WIFI_AP);
    bool ok = WiFi.softAP(WIFI_AP_SSID, WIFI_AP_PASSWORD);
    if (!ok) {
        WiFi.mode(WIFI_OFF); delay(120); WiFi.mode(WIFI_AP);
        ok = WiFi.softAP(WIFI_AP_SSID, WIFI_AP_PASSWORD);
    }
    if (ok) {
        s_apActive     = true;
        s_setupApMode  = true;
        Serial.print(F("[NET] AP started. SSID=")); Serial.print(WIFI_AP_SSID);
        Serial.print(F("  IP=")); Serial.println(WiFi.softAPIP());
    } else {
        Serial.println(F("[NET] AP start FAILED."));
    }
    ledOff();
}

// -----------------------------------------------------------
// /wifi-config POST handler — same endpoint as AD8232
// A mobile app POSTs {"ssid":"...","password":"...","deviceId":"...","userId":"..."}
// The ESP connects to the new WiFi, saves creds, stops AP.
// -----------------------------------------------------------
static void handleWifiConfig() {
    if (!s_server.hasArg("plain")) {
        s_server.send(400, "application/json", "{\"error\":\"No body\"}");
        return;
    }
    String body = s_server.arg("plain");
    Serial.println("[NET] /wifi-config: " + body);

    JsonDocument doc;
    if (deserializeJson(doc, body)) {
        s_server.send(400, "application/json", "{\"error\":\"Bad JSON\"}");
        return;
    }

    String ssid     = doc["ssid"]     | "";
    String password = doc["password"] | "";
    String newDid   = doc["deviceId"] | "";
    String newUid   = doc["userId"]   | "";

    // Save IDs if provided
    if (newDid.length() > 0) {
        newDid.toCharArray(s_deviceId, MAX_DEVICE_ID_LEN);
        s_prefs.begin(NVS_NAMESPACE, false);
        s_prefs.putString("device_id", newDid);
        s_prefs.end();
    }
    if (newUid.length() > 0) {
        newUid.toCharArray(s_userId, MAX_DEVICE_ID_LEN);
        s_prefs.begin(NVS_NAMESPACE, false);
        s_prefs.putString("user_id", newUid);
        s_prefs.end();
    }

    if (ssid.length() == 0 || password.length() == 0) {
        if (ssid.length() != password.length()) {
            Serial.println("[CFG] Partial WiFi credentials received; ignoring WiFi change");
        }
        String resp = "{";
        resp += "\"status\":\"ids_updated\",";
        resp += "\"deviceId\":\"" + String(s_deviceId) + "\",";
        resp += "\"userId\":\"" + String(s_userId) + "\",";
        resp += "\"connected\":" + String(WiFi.status() == WL_CONNECTED ? "true" : "false");
        resp += "}";

        s_server.send(200, "application/json", resp);
        Serial.println("[CFG] IDs updated without WiFi reconnect");
        return;
    }

    s_server.send(200, "application/json", "{\"status\":\"connecting\"}");
    delay(1500);

    // Try connecting to the new network
    WiFi.mode(WIFI_STA);
    bool ok = connectSTA(ssid, password, 20);

    if (ok) {
        saveCredentials(ssid, password);
        s_savedSsid       = ssid;
        s_savedPass       = password;
        s_hasCredentials  = true;
        s_reconnectEnabled= true;
        s_staConnected    = true;
        s_reconnectFails  = 0;
        s_apActive        = false;
        s_setupApMode     = false;
        WiFi.softAPdisconnect(true);
        WiFi.mode(WIFI_STA);
        ledOn();
        Serial.print(F("[NET] STA connected via config. IP="));
        Serial.println(WiFi.localIP());
    } else {
        Serial.println(F("[NET] Connect failed — restarting AP."));
        startAP();
    }
}

// -----------------------------------------------------------
// /status GET handler
// -----------------------------------------------------------
static void handleStatus() {
    bool connected = WiFi.status() == WL_CONNECTED;
    s_server.send(200, "application/json",
        String("{\"connected\":") + (connected ? "true" : "false") +
        ",\"deviceId\":\"" + s_deviceId + "\"}");
}

// -----------------------------------------------------------
// network_init()
// -----------------------------------------------------------
void network_init() {
    pinMode(LED_PIN, OUTPUT);
    ledOff();

    loadIds();
    Serial.printf("[NET] deviceId=%s  userId=%s\n", s_deviceId, s_userId);

    // -------------------------------------------------------
    // CRITICAL: Call WiFi.mode() FIRST to initialize the
    // lwIP TCP/IP stack (esp_netif_init). Any call to
    // s_server.begin() or WiFi functions before this will
    // crash with "Invalid mbox" (uninitialized lwIP mailbox).
    // -------------------------------------------------------
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.setAutoReconnect(false);  // We manage reconnect ourselves
    delay(100);                    // Let the stack settle

    // Web server for /wifi-config (safe now that stack is up)
    s_server.on("/wifi-config", HTTP_POST, handleWifiConfig);
    s_server.on("/status",      HTTP_GET,  handleStatus);
    s_server.begin();
    Serial.println(F("[NET] Web server started on port 80."));

    // Try to connect using saved credentials
    String ssid, pass;
    if (loadCredentials(ssid, pass)) {
        s_savedSsid      = ssid;
        s_savedPass      = pass;
        s_hasCredentials = true;
        s_reconnectEnabled = true;

        Serial.println(F("[NET] Saved credentials found — connecting STA..."));
        bool ok = connectSTA(ssid, pass, 20);

        if (ok) {
            s_staConnected   = true;
            s_reconnectFails = 0;
            ledOn();
            Serial.print(F("[NET] STA connected. IP="));
            Serial.println(WiFi.localIP());
            // AP disabled when successfully connected to router
            WiFi.mode(WIFI_STA);
            s_apActive    = false;
            s_setupApMode = false;
        } else {
            Serial.println(F("[NET] STA failed — starting AP."));
            startAP();
        }
    } else {
        // No saved credentials — go straight to AP
        Serial.println(F("[NET] No saved credentials — starting AP mode."));
        startAP();
    }

    // FreeRTOS upload queue
    s_uploadQueue = xQueueCreate(UPLOAD_QUEUE_DEPTH, sizeof(UploadPayload));
    if (!s_uploadQueue) {
        Serial.println(F("[NET] FATAL: upload queue creation failed!"));
        return;
    }

    xTaskCreatePinnedToCore(uploadTask, "ecg_upload", 8192, nullptr, 1, nullptr, 0);
    Serial.println(F("[NET] Upload task started on Core 0."));
}

// -----------------------------------------------------------
// network_update() — call every loop() iteration
// -----------------------------------------------------------
void network_update() {
    s_server.handleClient();   // Serve the /wifi-config endpoint

    uint32_t now = millis();
    bool currentlyConnected = (WiFi.status() == WL_CONNECTED);

    // STA just reconnected
    if (currentlyConnected && !s_staConnected) {
        s_staConnected   = true;
        s_staLostTimeMs  = 0;
        s_reconnectFails = 0;
        ledOn();
        Serial.print(F("[NET] STA reconnected. IP="));
        Serial.println(WiFi.localIP());
        // Turn off AP mode since we are connected to the router
        if (s_apActive) {
            WiFi.softAPdisconnect(true);
        }
        WiFi.mode(WIFI_STA);
        s_apActive    = false;
        s_setupApMode = false;
    }

    // STA just dropped
    if (!currentlyConnected && s_staConnected) {
        s_staConnected  = false;
        s_staLostTimeMs = now;
        ledOff();
        Serial.println(F("[NET] STA disconnected."));
    }

    // Reconnect / AP-fallback logic
    if (!s_staConnected && s_reconnectEnabled && s_hasCredentials) {
        // Force AP after 15s of STA being down
        if (s_staLostTimeMs > 0 && (now - s_staLostTimeMs) >= WIFI_AP_TIMEOUT_MS && !s_setupApMode) {
            Serial.println(F("[NET] STA down 15s — starting AP fallback."));
            WiFi.mode(WIFI_AP_STA);
            WiFi.softAP(WIFI_AP_SSID, WIFI_AP_PASSWORD);
            s_apActive    = true;
            s_setupApMode = true;
        }

        // Periodic STA reconnect attempt
        if ((now - s_lastReconnectMs) >= WIFI_RECONNECT_INTERVAL_MS) {
            s_lastReconnectMs = now;
            Serial.println(F("[NET] Attempting STA reconnect..."));

            WiFi.disconnect(false, false);
            delay(50);
            bool ok = connectSTA(s_savedSsid, s_savedPass, 8);

            if (ok) {
                s_staConnected   = true;
                s_reconnectFails = 0;
                s_staLostTimeMs  = 0;
                ledOn();
                // Ensure AP is totally off since we are connected
                WiFi.softAPdisconnect(true);
                WiFi.mode(WIFI_STA);
                s_apActive    = false;
                s_setupApMode = false;
                Serial.print(F("[NET] Reconnect OK. IP="));
                Serial.println(WiFi.localIP());
            } else {
                if (s_reconnectFails < 255) s_reconnectFails++;
                Serial.printf("[NET] Reconnect failed (%d/%d)\n", s_reconnectFails, RECONNECT_FAIL_LIMIT);
                if (s_reconnectFails >= RECONNECT_FAIL_LIMIT && !s_setupApMode) {
                    Serial.println(F("[NET] Too many failures — switching to AP mode."));
                    WiFi.mode(WIFI_AP_STA);
                    WiFi.softAP(WIFI_AP_SSID, WIFI_AP_PASSWORD);
                    s_apActive    = true;
                    s_setupApMode = true;
                    s_reconnectFails = RECONNECT_FAIL_LIMIT;  // saturate
                }
            }
        }
    }

    // LED now strictly stays ON when connected, and OFF otherwise. No pulsing in AP mode.
}

// -----------------------------------------------------------
// network_isConnected()
// -----------------------------------------------------------
bool network_isConnected() {
    return s_staConnected;
}

// -----------------------------------------------------------
// network_uploadBlock() — non-blocking, called from loop()
// -----------------------------------------------------------
bool network_uploadBlock(const Block& blk, bool leadsOff, bool loPlus, bool loMinus, const char* warning, const char* severity) {
    if (!s_uploadQueue) return false;
    UploadPayload p;
    p.blk      = blk;
    p.leadsOff = leadsOff;
    p.loPlus   = loPlus;
    p.loMinus  = loMinus;
    
    if (warning != nullptr) {
        strncpy(p.warning, warning, sizeof(p.warning) - 1);
        p.warning[sizeof(p.warning) - 1] = '\0';
    } else {
        p.warning[0] = '\0';
    }

    if (severity != nullptr) {
        strncpy(p.severity, severity, sizeof(p.severity) - 1);
        p.severity[sizeof(p.severity) - 1] = '\0';
    } else {
        p.severity[0] = '\0';
    }

    // Explicitly log exactly what is going into the database payload
    Serial.print(F("#DB_PAYLOAD -> seq=")); Serial.print(blk.seq);
    Serial.print(F(" | lo=")); Serial.print(leadsOff ? "TRUE" : "FALSE");
    if (p.warning[0] != '\0') {
        Serial.print(F(" | warn=["));
        Serial.print(p.warning);
        Serial.print(F("]"));
    }
    if (p.severity[0] != '\0') {
        Serial.print(F(" | sev=["));
        Serial.print(p.severity);
        Serial.print(F("]"));
    }
    Serial.println();

    if (xQueueSend(s_uploadQueue, &p, 0) != pdTRUE) {
        Serial.println(F("[NET] Upload queue full — block dropped."));
        return false;
    }
    return true;
}

// -----------------------------------------------------------
// syncUserIdFromBackend() — Called every 15s in Core 0
// -----------------------------------------------------------
static unsigned long s_lastUserSyncMs = 0;

static void syncUserIdFromBackend() {
    if (strlen(s_deviceId) == 0) return;

    String url = String("https://") + API_HOST + "/api/wifi-config/device/" + String(s_deviceId);
    
    WiFiClientSecure syncClient;
    syncClient.setInsecure();
    
    HTTPClient http;
    http.begin(syncClient, url);
    int code = http.GET();
    if (code == 200 || code == 201) {
        String payload = http.getString();
        JsonDocument doc;
        if (!deserializeJson(doc, payload)) {
            const char* uid = doc["userId"];
            if (uid && strlen(uid) > 0 && strcmp(uid, s_userId) != 0) {
                strncpy(s_userId, uid, MAX_DEVICE_ID_LEN - 1);
                s_userId[MAX_DEVICE_ID_LEN - 1] = '\0';
                
                s_prefs.begin(NVS_NAMESPACE, false);
                s_prefs.putString("user_id", s_userId);
                s_prefs.end();
                Serial.print(F("[NET] Synced userId from backend: "));
                Serial.println(s_userId);
            }
        }
    }
    http.end();
}

// -----------------------------------------------------------
// uploadTask() — Core 0
// -----------------------------------------------------------
static void uploadTask(void* pv) {
    UploadPayload p;
    for (;;) {
        if (xQueueReceive(s_uploadQueue, &p, pdMS_TO_TICKS(1000)) == pdTRUE) {
            if (s_staConnected) {
                String json;
                buildJsonPayload(p, json);
                if (!postPayload(json)) {
                    Serial.println(F("[NET] HTTP POST failed."));
                }
            }
        }

        if (s_staConnected) {
            unsigned long now = millis();
            if (now - s_lastUserSyncMs >= 15000) {
                s_lastUserSyncMs = now;
                syncUserIdFromBackend();
            }
        }
    }
}

// -----------------------------------------------------------
// buildJsonPayload()
// Matches the string concatenation payload EXACTLY.
// -----------------------------------------------------------
static void buildJsonPayload(const UploadPayload& p, String& out) {
    out.reserve(2048);
    out = "{";
    out += "\"userId\":\"" + String(s_userId) + "\",";
    out += "\"deviceId\":\"" + String(s_deviceId) + "\",";
    out += "\"seq\":" + String(p.blk.seq) + ",";
    out += "\"sr\":" + String(SAMPLE_RATE) + ",";
    out += "\"lo\":" + String(p.leadsOff ? "true" : "false") + ",";
    out += "\"loPlus\":" + String(p.loPlus ? "true" : "false") + ",";
    out += "\"loMinus\":" + String(p.loMinus ? "true" : "false") + ",";
    if (p.warning[0] != '\0') {
        out += "\"warnings\":[\"" + String(p.warning) + "\"],";
    }
    if (p.severity[0] != '\0') {
        out += "\"severity\":\"" + String(p.severity) + "\",";
    }
    out += "\"data\":[";

    for (int i = 0; i < WINDOW_SIZE; i++) {
        out += String(p.blk.data[i]);
        if (i < WINDOW_SIZE - 1) out += ",";
    }
    out += "]}";
}

// -----------------------------------------------------------
// postPayload() — HTTPS POST on Core 0
// -----------------------------------------------------------
static WiFiClientSecure s_secureClient;
static HTTPClient s_httpClient;
static bool s_httpClientInit = false;

static bool postPayload(const String& json) {
    if (!s_httpClientInit) {
        s_secureClient.setInsecure();   // Accept Render's valid Let's Encrypt cert
        s_httpClientInit = true;
    }

    String url = String("https://") + API_HOST + API_ENDPOINT;
    s_httpClient.begin(s_secureClient, url);
    s_httpClient.addHeader("Content-Type", "application/json");
    s_httpClient.addHeader("Connection", "keep-alive");
    s_httpClient.setTimeout(API_TIMEOUT_MS);
    s_httpClient.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

    uint32_t t0 = millis();
    int code = s_httpClient.POST(json);
    uint32_t t1 = millis();
    s_httpClient.end(); // Clean up response buffer, keeps connection alive underneath

    if (code == 200 || code == 201) {
        Serial.printf("[NET] POST OK (HTTP %d, %u ms)\n", code, t1 - t0);
        return true;
    }
    Serial.printf("[NET] POST failed, HTTP=%d (%u ms)\n", code, t1 - t0);
    return false;
}
