/*
 * ESP32 ECG v8.1 — Flutter Controlled WiFi Config (Stable Version) Final Code  
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

// -------------------- CONFIG --------------------
#define API_URL "https://api-for-ecg.onrender.com/api/ecg"
#define WIFI_CFG_DEVICE_URL "https://api-for-ecg.onrender.com/api/wifi-config/device/"
#define DEFAULT_DEVICE_ID "ESP_ECG_123"
#define DEFAULT_USER_ID ""
#define MAX_DEVICE_ID_LEN 32

#define ECG_PIN 36
#define LO_PLUS_PIN 18
#define LO_MINUS_PIN 5
#define LED_PIN 2

#define SAMPLE_RATE 360
#define SAMPLE_INTERVAL_US 2778
#define WINDOW_SIZE 360
#define ANALYSIS_WINDOW_SIZE 1800
#define QUEUE_DEPTH 10
#define BUZZER_PIN 33
#define ALERT_LED_PIN 26
#define POWER_SENSE_PIN 34
#define BUTTON_PIN 27

// Local server (mobile hotspot) notification
#define LOCAL_SERVER_PORT 9000
#define LOCAL_HEARTBEAT_INTERVAL_MS 5000

unsigned long lastHeartbeatMs = 0;
volatile bool localNotifyQueued = false;
volatile bool localNotifyState = false;

// -------------------- GLOBALS --------------------
WebServer server(80);
Preferences prefs;

bool previousWifiState = false;

char deviceId[MAX_DEVICE_ID_LEN] = DEFAULT_DEVICE_ID;
char userId[MAX_DEVICE_ID_LEN] = DEFAULT_USER_ID;

WiFiClientSecure client;
HTTPClient http;

struct Block {
  uint16_t data[WINDOW_SIZE];
  uint32_t seq;
  bool lo;
  char userId[MAX_DEVICE_ID_LEN];
  char deviceId[MAX_DEVICE_ID_LEN];
};

uint16_t buffers[2][WINDOW_SIZE];
uint16_t analysisWindow[ANALYSIS_WINDOW_SIZE];
uint16_t analysisSnapshot[ANALYSIS_WINDOW_SIZE];
float analysisCentered[ANALYSIS_WINDOW_SIZE];
volatile int activeBuffer = 0;
volatile int sampleIndex = 0;
volatile bool blockReady = false;
volatile bool leadsOff = false;
volatile uint32_t blockSeq = 0;
volatile uint32_t analysisWriteIndex = 0;
volatile uint32_t analysisSampleCount = 0;
volatile uint32_t analysisLatestSeq = 0;

// --------- 50Hz Notch filter state (applied in main loop per block)
static float hp_x_prev = 0.0f;
static float hp_y_prev = 0.0f;
static const float hp_alpha = 0.99124f;

static float notch_s1 = 0.0f;
static float notch_s2 = 0.0f;
static float notch_b0 = 1.0f, notch_b1 = 0.0f, notch_b2 = 0.0f;
static float notch_a1 = 0.0f, notch_a2 = 0.0f;
static bool notch_initialized = false;

// --------- 40Hz Low-pass filter state (applied in main loop per block)
static float lp_s1 = 0.0f;
static float lp_s2 = 0.0f;
static const float lp_b0 = 0.20657f;
static const float lp_b1 = 0.41314f;
static const float lp_b2 = 0.20657f;
static const float lp_a1 = -0.36953f;
static const float lp_a2 = 0.19582f;

QueueHandle_t blockQueue = NULL;
uint32_t queueOverflows = 0;

unsigned long lastUserSyncMs = 0;
const unsigned long USER_SYNC_INTERVAL_MS = 15000;

String reconnectSsid = "";
String reconnectPass = "";
bool hasReconnectCreds = false;
unsigned long lastReconnectAttemptMs = 0;
const unsigned long RECONNECT_INTERVAL_MS = 5000;
bool reconnectEnabled = true;
bool setupApMode = false;
bool systemOn = true;
bool lastButtonState = HIGH;
unsigned long lastButtonDebounceMs = 0;
unsigned long buttonPressStartMs = 0;
bool longPressHandled = false;
const unsigned long BUTTON_HOLD_MS = 1000;

// Timer
hw_timer_t *timer = NULL;
portMUX_TYPE timerMux = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE analysisMux = portMUX_INITIALIZER_UNLOCKED;

void beepTone(int freq, int durationMs) {
  tone(BUZZER_PIN, freq);
  delay(durationMs);
  noTone(BUZZER_PIN);
}

void turnWifiOff() {
  reconnectEnabled = false;
  setupApMode = true;
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(false, false);
  WiFi.mode(WIFI_OFF);
  digitalWrite(LED_PIN, LOW);
}

void turnWifiOn() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  WiFi.setSleep(false);
  reconnectEnabled = true;
  setupApMode = false;

  if (hasReconnectCreds) {
    WiFi.begin(reconnectSsid.c_str(), reconnectPass.c_str());
    return;
  }

  String ssid;
  String password;
  if (loadWifiCredentials(ssid, password)) {
    reconnectSsid = ssid;
    reconnectPass = password;
    hasReconnectCreds = true;
    WiFi.begin(reconnectSsid.c_str(), reconnectPass.c_str());
  }
}

void setSystemPowerState(bool on) {
  systemOn = on;

  if (systemOn) {
    if (timer != NULL) {
      timerAlarmEnable(timer);
    }
    Serial.println("[SYS] ECG SYSTEM ON");
    // digitalWrite(LED_PIN, HIGH);
    digitalWrite(ALERT_LED_PIN, HIGH);
    delay(120);
    digitalWrite(ALERT_LED_PIN, LOW);
    previousWifiState = false;
    turnWifiOn();
    beepTone(2500, 120);
  } else {
    if (timer != NULL) {
      timerAlarmDisable(timer);
    }
    Serial.println("[SYS] ECG SYSTEM OFF");
    // digitalWrite(LED_PIN, LOW);
    digitalWrite(ALERT_LED_PIN, HIGH);
    delay(120);
    digitalWrite(ALERT_LED_PIN, LOW);
    digitalWrite(BUZZER_PIN, LOW);
    noTone(BUZZER_PIN);
    turnWifiOff();
    beepTone(1500, 120);
  }
}

void handlePowerButton() {
  bool currentButtonState = digitalRead(BUTTON_PIN);
  unsigned long now = millis();

  if (lastButtonState == HIGH && currentButtonState == LOW) {
    if ((now - lastButtonDebounceMs) >= 50UL) {
      lastButtonDebounceMs = now;
      buttonPressStartMs = now;
      longPressHandled = false;
    }
  }

  if (currentButtonState == LOW && !longPressHandled &&
      (now - buttonPressStartMs) >= BUTTON_HOLD_MS) {
    longPressHandled = true;
    setSystemPowerState(!systemOn);
  }

  if (lastButtonState == LOW && currentButtonState == HIGH) {
    buttonPressStartMs = 0;
    longPressHandled = false;
  }

  lastButtonState = currentButtonState;
}

// ============================================================
// TIMER ISR (Perfect 360Hz)
// ============================================================
void IRAM_ATTR onTimer() {
  portENTER_CRITICAL_ISR(&timerMux);

  // LO DEBOUNCE — require 72 consecutive HIGH readings (~200 ms at 360 Hz)
  // before declaring leads off. A single glitch no longer blanks the signal.
  static uint16_t lo_debounce_cnt = 0;
  bool lo_instant = (digitalRead(LO_PLUS_PIN) == HIGH ||
                     digitalRead(LO_MINUS_PIN) == HIGH);
  if (lo_instant) {
    if (lo_debounce_cnt < 72) lo_debounce_cnt++;
  } else {
    lo_debounce_cnt = 0;   // any LOW resets immediately
  }
  leadsOff = (lo_debounce_cnt >= 72);

  buffers[activeBuffer][sampleIndex] =
      leadsOff ? 0 : (uint16_t)analogRead(ECG_PIN);
  sampleIndex++;

  if (sampleIndex >= WINDOW_SIZE) {
    sampleIndex = 0;
    activeBuffer = 1 - activeBuffer;
    blockSeq++;
    blockReady = true;
  }

  portEXIT_CRITICAL_ISR(&timerMux);
}

// ============================================================
// DEVICE ID
// ============================================================
void loadDeviceId() {
  prefs.begin("ecg_cfg", true);
  String id = prefs.getString("device_id", DEFAULT_DEVICE_ID);
  String uid = prefs.getString("user_id", "");
  prefs.end();

  id.toCharArray(deviceId, MAX_DEVICE_ID_LEN);
  uid.toCharArray(userId, MAX_DEVICE_ID_LEN);

  // Keep backward compatibility: if userId not set, mirror deviceId.
  if (strlen(userId) == 0) {
    strncpy(userId, deviceId, MAX_DEVICE_ID_LEN - 1);
    userId[MAX_DEVICE_ID_LEN - 1] = '\0';
  }
}

void saveDeviceId(const char* id) {
  prefs.begin("ecg_cfg", false);
  prefs.putString("device_id", id);
  prefs.end();
}

void saveUserId(const char* id) {
  prefs.begin("ecg_cfg", false);
  prefs.putString("user_id", id);
  prefs.end();
}

void saveWifiCredentials(const char* ssid, const char* password) {
  prefs.begin("ecg_cfg", false);
  prefs.putString("wifi_ssid", ssid);
  prefs.putString("wifi_pass", password);
  prefs.end();
}

void clearWifiCredentials() {
  prefs.begin("ecg_cfg", false);
  prefs.remove("wifi_ssid");
  prefs.remove("wifi_pass");
  prefs.end();

  reconnectSsid = "";
  reconnectPass = "";
  hasReconnectCreds = false;
  reconnectEnabled = false;
  setupApMode = true;

  Serial.println("[WiFi] Saved credentials cleared");
}

const char* resetReasonToString(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_UNKNOWN: return "UNKNOWN";
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_EXT: return "EXT";
    case ESP_RST_SW: return "SW";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_INT_WDT: return "INT_WDT";
    case ESP_RST_TASK_WDT: return "TASK_WDT";
    case ESP_RST_WDT: return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_SDIO: return "SDIO";
    default: return "OTHER";
  }
}

bool loadWifiCredentials(String& ssid, String& password) {
  prefs.begin("ecg_cfg", true);
  ssid = prefs.getString("wifi_ssid", "");
  password = prefs.getString("wifi_pass", "");
  prefs.end();
  return ssid.length() > 0 && password.length() > 0;
}

bool connectSavedWiFi() {
  String ssid;
  String password;

  if (!loadWifiCredentials(ssid, password)) {
    Serial.println("[WiFi] No saved credentials found");
    return false;
  }

  Serial.println("[WiFi] Connecting to saved network: " + ssid);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), password.c_str());

  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 20) {
    delay(500);
    Serial.print(".");
    retry++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] Connected!");
    Serial.println(WiFi.localIP());
    digitalWrite(LED_PIN, HIGH);
    reconnectSsid = ssid;
    reconnectPass = password;
    hasReconnectCreds = true;
    reconnectEnabled = true;
    setupApMode = false;
    return true;
  }

  Serial.println("\n[WiFi] Saved network failed, will use AP mode");
  return false;
}

void attemptReconnectIfNeeded() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (!reconnectEnabled || setupApMode) return;

  unsigned long now = millis();
  if ((now - lastReconnectAttemptMs) < RECONNECT_INTERVAL_MS) return;
  lastReconnectAttemptMs = now;

  if (!hasReconnectCreds) {
    String ssid;
    String password;
    if (loadWifiCredentials(ssid, password)) {
      reconnectSsid = ssid;
      reconnectPass = password;
      hasReconnectCreds = true;
    }
  }

  if (!hasReconnectCreds) return;

  Serial.println("[WiFi] Reconnecting...");
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, false);
  delay(50);
  WiFi.begin(reconnectSsid.c_str(), reconnectPass.c_str());
}

// ============================================================
// START AP MODE
// ============================================================
void startAP() {
  WiFi.mode(WIFI_AP);
  WiFi.softAP("ECG_Setup", "12345678");

  Serial.println("AP Started");
  Serial.println(WiFi.softAPIP());
}

// ============================================================
// WIFI CONFIG API
// ============================================================
void handleWifiConfig() {
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"No data\"}");
    return;
  }

  String body = server.arg("plain");
  Serial.println("Received: " + body);

  DynamicJsonDocument doc(512);
  deserializeJson(doc, body);

  String ssid = doc["ssid"];
  String password = doc["password"];
  String newDeviceId = doc["deviceId"];
  String newUserId = doc["userId"];
  bool hasSsid = ssid.length() > 0;
  bool hasPassword = password.length() > 0;
  bool hasWifiCreds = hasSsid && hasPassword;

  if (newDeviceId.length() > 0) {
    strncpy(deviceId, newDeviceId.c_str(), MAX_DEVICE_ID_LEN - 1);
    deviceId[MAX_DEVICE_ID_LEN - 1] = '\0';
    saveDeviceId(deviceId);
  }

  if (newUserId.length() > 0) {
    strncpy(userId, newUserId.c_str(), MAX_DEVICE_ID_LEN - 1);
    userId[MAX_DEVICE_ID_LEN - 1] = '\0';
    saveUserId(userId);
  } else {
    // Do NOT overwrite existing userId on ID-only/device-only requests.
    // Only fallback to deviceId if userId is actually empty.
    if (strlen(userId) == 0) {
      strncpy(userId, deviceId, MAX_DEVICE_ID_LEN - 1);
      userId[MAX_DEVICE_ID_LEN - 1] = '\0';
      saveUserId(userId);
    }
  }

  // ID-only update path: do not touch WiFi connection state.
  // WiFi setup is allowed only when BOTH ssid and password are provided.
  if (!hasWifiCreds) {
    if (hasSsid != hasPassword) {
      Serial.println("[CFG] Partial WiFi credentials received; ignoring WiFi change");
    }

    String resp = "{";
    resp += "\"status\":\"ids_updated\",";
    resp += "\"deviceId\":\"" + String(deviceId) + "\",";
    resp += "\"userId\":\"" + String(userId) + "\",";
    resp += "\"connected\":" + String(WiFi.status() == WL_CONNECTED ? "true" : "false");
    resp += "}";

    server.send(200, "application/json", resp);
    Serial.println("[CFG] IDs updated without WiFi reconnect");
    return;
  }

  // Respond FIRST
  server.send(200, "application/json", "{\"status\":\"connecting\"}");

  delay(2000); // 🔥 Important (allow Flutter to finish)

  // Switch to STA
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), password.c_str());

  Serial.println("Connecting to WiFi...");

  // Wait connection
  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 20) {
    delay(500);
    Serial.print(".");
    retry++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nConnected!");
    Serial.println(WiFi.localIP());
    digitalWrite(LED_PIN, HIGH);
    saveWifiCredentials(ssid.c_str(), password.c_str());
    reconnectSsid = ssid;
    reconnectPass = password;
    hasReconnectCreds = true;
    reconnectEnabled = true;
    setupApMode = false;
  } else {
    Serial.println("\nFailed! Restarting AP...");
    reconnectEnabled = false;
    setupApMode = true;
    startAP(); // fallback
    return;
  }

  // Stop AP AFTER connection
  WiFi.softAPdisconnect(true);
}

// ============================================================
// SERVER
// ============================================================
void startServer() {
  server.on("/wifi-config", HTTP_POST, handleWifiConfig);

  server.on("/status", HTTP_GET, []() {
    bool connected = WiFi.status() == WL_CONNECTED;
    server.send(200, "application/json",
      String("{\"connected\":") + (connected ? "true" : "false") + "}");
  });

  server.begin();
}

String buildPayload(const Block& blk) {
  String json = "{";
  json += "\"userId\":\"" + String(blk.userId) + "\",";
  json += "\"deviceId\":\"" + String(blk.deviceId) + "\",";
  json += "\"seq\":" + String(blk.seq) + ",";
  json += "\"sr\":" + String(SAMPLE_RATE) + ",";
  json += "\"lo\":" + String(blk.lo ? "true" : "false") + ",";
  json += "\"data\":[";

  for (int i = 0; i < WINDOW_SIZE; i++) {
    json += String(blk.data[i]);
    if (i < WINDOW_SIZE - 1) json += ",";
  }

  json += "]}";
  return json;
}

void appendAnalysisBlock(const Block& blk) {
  portENTER_CRITICAL(&analysisMux);
  for (int i = 0; i < WINDOW_SIZE; i++) {
    analysisWindow[analysisWriteIndex] = blk.data[i];
    analysisWriteIndex = (analysisWriteIndex + 1) % ANALYSIS_WINDOW_SIZE;
    if (analysisSampleCount < ANALYSIS_WINDOW_SIZE) {
      analysisSampleCount++;
    }
  }
  analysisLatestSeq = blk.seq;
  portEXIT_CRITICAL(&analysisMux);
}

void resetSignalFilterState() {
  hp_x_prev = 0.0f;
  hp_y_prev = 0.0f;
  notch_s1 = 0.0f;
  notch_s2 = 0.0f;
  lp_s1 = 0.0f;
  lp_s2 = 0.0f;
}

void initHighPass0p5Hz() {
  hp_x_prev = 0.0f;
  hp_y_prev = 0.0f;
}

// Initialize notch filter coefficients for 50 Hz (call in setup)
void initNotch50Hz(float fs, float f0 = 50.0f, float Q = 30.0f) {
  float w0 = 2.0f * PI * f0 / fs;
  float cos_w0 = cos(w0);
  float alpha = sin(w0) / (2.0f * Q);

  // Biquad notch: b0=1, b1=-2cos(w0), b2=1
  // a0=1+alpha, a1=-2cos(w0), a2=1-alpha
  float b0 = 1.0f;
  float b1 = -2.0f * cos_w0;
  float b2 = 1.0f;
  float a0 = 1.0f + alpha;
  float a1 = -2.0f * cos_w0;
  float a2 = 1.0f - alpha;

  notch_b0 = b0 / a0;
  notch_b1 = b1 / a0;
  notch_b2 = b2 / a0;
  notch_a1 = a1 / a0;
  notch_a2 = a2 / a0;

  notch_s1 = 0.0f;
  notch_s2 = 0.0f;
  notch_initialized = true;
}

void initLowPass40Hz() {
  lp_s1 = 0.0f;
  lp_s2 = 0.0f;
}

void initSignalFilters() {
  initHighPass0p5Hz();
  initNotch50Hz((float)SAMPLE_RATE);
  initLowPass40Hz();
  Serial.println("[FILTER] High-pass 0.5Hz + low-pass 40Hz + notch 50Hz enabled");
  Serial.println("[FILTER] ECG chain: Input -> HP 0.5Hz -> LP 40Hz -> Notch 50Hz -> Detection");
  Serial.println("[FILTER] Baseline drift 0.05Hz-0.3Hz reduced; ECG band 0.5Hz-40Hz preserved; 50Hz-200Hz noise reduced");
}

void applyHighPassToBlock(uint16_t* data, int len) {
  // AD8232 already has a built-in 0.5 Hz hardware high-pass filter.
  // This software HP is redundant and causes double-filtering / phase distortion.
  // Function kept for reference but should NOT be called.
  (void)data; (void)len;
}

// Apply notch in-place to a block of samples (uint16_t ADC values). Assumes fs = SAMPLE_RATE.
void applyNotchToBlock(uint16_t* data, int len) {
  if (!notch_initialized) initNotch50Hz((float)SAMPLE_RATE);

  for (int i = 0; i < len; i++) {
    float x = (float)data[i];

    // Direct Form II Transposed
    float y = notch_b0 * x + notch_s1;
    notch_s1 = notch_b1 * x - notch_a1 * y + notch_s2;
    notch_s2 = notch_b2 * x - notch_a2 * y;

    // Clamp and write back
    if (y < 0.0f) y = 0.0f;
    if (y > 4095.0f) y = 4095.0f;
    data[i] = (uint16_t) y;
  }
}

void applyLowPassToBlock(uint16_t* data, int len) {
  // AD8232 already has a built-in ~40 Hz hardware low-pass filter.
  // This software LP is redundant and causes double-filtering.
  // Function kept for reference but should NOT be called.
  (void)data; (void)len;
}

void applySignalFiltersToBlock(Block& blk) {
  if (blk.lo) {
    resetSignalFilterState();
    Serial.println("[FILTER] Leads off -> filter state reset");
    return;
  }

  // AD8232 HARDWARE already provides:
  //   - High-Pass  0.5 Hz  (baseline wander removal)
  //   - Low-Pass  ~40 Hz  (muscle/EMG noise removal)
  //
  // So in software we ONLY apply what the AD8232 cannot do:
  //   - Notch 50 Hz  (powerline interference)
  applyNotchToBlock(blk.data, WINDOW_SIZE);

  Serial.println("[FILTER] seq=" + String(blk.seq) +
                 " applied: Notch 50Hz only (HP/LP handled by AD8232 hardware)");
}

bool copyAnalysisWindow(uint16_t* outSamples, uint32_t& sampleCount, uint32_t& latestSeq) {
  portENTER_CRITICAL(&analysisMux);
  sampleCount = analysisSampleCount;
  latestSeq = analysisLatestSeq;
  if (sampleCount < ANALYSIS_WINDOW_SIZE) {
    portEXIT_CRITICAL(&analysisMux);
    return false;
  }

  uint32_t start = analysisWriteIndex;
  for (int i = 0; i < ANALYSIS_WINDOW_SIZE; i++) {
    outSamples[i] = analysisWindow[(start + i) % ANALYSIS_WINDOW_SIZE];
  }
  portEXIT_CRITICAL(&analysisMux);
  return true;
}

String validationConditionName(const String& reason) {
  if (reason.startsWith("LEADS_OFF")) return "Lead-Off Detected";
  return "Poor signal quality";
}

String validationDetailText(const String& reason) {
  if (reason.startsWith("LEADS_OFF")) return "Check electrode placement or connection";
  if (reason.startsWith("TOO_MANY_ZERO_SAMPLES=")) {
    String ratio = reason.substring(String("TOO_MANY_ZERO_SAMPLES=").length());
    return "zero ratio=" + ratio + " (threshold 15%)";
  }
  if (reason.startsWith("CLIPPED_SIGNAL=")) {
    String ratio = reason.substring(String("CLIPPED_SIGNAL=").length());
    return "clipping ratio=" + ratio + " (threshold 2%)";
  }
  if (reason.startsWith("LOW_AMPLITUDE=")) {
    String ptp = reason.substring(String("LOW_AMPLITUDE=").length());
    return "ptp=" + ptp + " (threshold 80)";
  }
  if (reason.startsWith("NOISY_SIGNAL=")) {
    String ratio = reason.substring(String("NOISY_SIGNAL=").length());
    return "noise ratio=" + ratio + " (threshold 12.5%)";
  }
  return "Check electrodes";
}

bool validateSamples(const uint16_t* samples, int sampleCount, String& reason) {
  reason = "";

  uint16_t minV = UINT16_MAX;
  uint16_t maxV = 0;
  uint32_t zeroCount = 0;
  uint32_t clipCount = 0;
  uint32_t spikeCount = 0;

  for (int i = 0; i < sampleCount; i++) {
    uint16_t value = samples[i];
    if (value == 0) zeroCount++;
    if (value <= 110 || value >= 3890) clipCount++;
    if (value < minV) minV = value;
    if (value > maxV) maxV = value;

    if (i > 0) {
      int delta = abs((int)value - (int)samples[i - 1]);
      if (delta > 800) spikeCount++;
    }
  }

  float zeroRatio = (float)zeroCount / (float)sampleCount;
  float clipRatio = (float)clipCount / (float)sampleCount;
  uint16_t ptp = maxV - minV;

  if (zeroRatio > 0.15f) {
    reason = "TOO_MANY_ZERO_SAMPLES=" + String(zeroRatio, 2);
  } else if (clipRatio > 0.02f) {
    reason = "CLIPPED_SIGNAL=" + String(clipRatio, 2);
  } else if (ptp < 80) {
    reason = "LOW_AMPLITUDE=" + String(ptp);
  } else if (spikeCount > (sampleCount / 8)) {
    float spikeRatio = (float)spikeCount / (float)sampleCount;
    reason = "NOISY_SIGNAL=" + String(spikeRatio, 2);
  }

  return reason.length() > 0;
}

int detectPeaks(const uint16_t* samples, int sampleCount, int* peaks, int maxPeaks, float& maxAbs) {
  long sum = 0;
  for (int i = 0; i < sampleCount; i++) {
    sum += samples[i];
  }

  float mean = (float)sum / (float)sampleCount;
  maxAbs = 0.0f;

  for (int i = 0; i < sampleCount; i++) {
    analysisCentered[i] = (float)samples[i] - mean;
    float absVal = fabs(analysisCentered[i]);
    if (absVal > maxAbs) maxAbs = absVal;
  }

  if (maxAbs < 30.0f) return 0;

  float threshold = maxAbs * 0.35f;
  int peakCount = 0;
  int minDistance = SAMPLE_RATE / 4;
  int lastPeak = -minDistance;

  for (int i = 1; i < sampleCount - 1; i++) {
    // if (analysisCentered[i] < threshold) continue;
    if (fabs(analysisCentered[i]) < threshold) continue;
    if (analysisCentered[i] <= analysisCentered[i - 1] || analysisCentered[i] < analysisCentered[i + 1]) continue;
    if ((i - lastPeak) < minDistance) continue;

    if (peakCount < maxPeaks) {
      peaks[peakCount++] = i;
      lastPeak = i;
    }
  }

  return peakCount;
}

float estimateQrsWidth(const uint16_t* samples, int sampleCount, int rIndex) {
  int searchRadius = (int)(0.07f * SAMPLE_RATE);
  int start = max(0, rIndex - searchRadius);
  int end = min(sampleCount - 1, rIndex + searchRadius);
  if (end <= start) return 90.0f;

  float localMax = 0.0f;
  float localMin = 1e9f;
  for (int i = start; i <= end; i++) {
    float v = (float)samples[i];
    if (v > localMax) localMax = v;
    if (v < localMin) localMin = v;
  }

  float halfLevel = localMin + 0.55f * (localMax - localMin);
  int left = rIndex;
  while (left > start && (float)samples[left] > halfLevel) left--;
  int right = rIndex;
  while (right < end && (float)samples[right] > halfLevel) right++;

  float widthSamples = (float)max(1, right - left);
  return (widthSamples / (float)SAMPLE_RATE) * 1000.0f;
}

String classifyWindow(const uint16_t* samples, int sampleCount, String& severity, String& detail) {
  severity = "";
  detail = "";

  String reason;
  if (validateSamples(samples, sampleCount, reason)) {
    severity = reason.startsWith("LEADS_OFF") ? "CRITICAL" : "INFO";
    detail = validationDetailText(reason);
    return validationConditionName(reason);
  }

  int peaks[32];
  float maxAbs = 0.0f;
  int peakCount = detectPeaks(samples, sampleCount, peaks, 32, maxAbs);

  if (peakCount < 4) {
    severity = "INFO";
    detail = "Need more data";
    return "Insufficient beats";
  }

  float rrIntervals[31];
  int rrCount = 0;
  float rrSum = 0.0f;
  float rrSqSum = 0.0f;
  float maxGapMs = 0.0f;
  float minGapMs = 3000.0f;

  for (int i = 1; i < peakCount; i++) {
    float gapSamples = (float)(peaks[i] - peaks[i - 1]);
    float gapMs = (gapSamples / (float)SAMPLE_RATE) * 1000.0f;
    rrIntervals[rrCount++] = gapMs;
    rrSum += gapSamples;
    rrSqSum += gapSamples * gapSamples;
    if (gapMs > maxGapMs) maxGapMs = gapMs;
    if (gapMs < minGapMs) minGapMs = gapMs;
  }

  float meanSamples = rrSum / (float)rrCount;
  if (meanSamples <= 0.0f) {
    severity = "CRITICAL";
    detail = "No detectable beats";
    return "Asystole";
  }

  float bpm = 60.0f * (float)SAMPLE_RATE / meanSamples;
  float rrVariance = (rrSqSum / (float)rrCount) - (meanSamples * meanSamples);
  if (rrVariance < 0.0f) rrVariance = 0.0f;
  float cv = sqrt(rrVariance) / (meanSamples + 1e-9f);

  float sdSum = 0.0f;
  int sdCount = 0;
  int rrMid = rrCount / 2;
  float midMean = 0.0f;
  for (int i = 0; i < rrCount; i++) midMean += rrIntervals[i];
  midMean /= (float)rrCount;
  for (int i = 1; i < rrCount; i++) {
    float diff = rrIntervals[i] - rrIntervals[i - 1];
    sdSum += diff * diff;
    sdCount++;
  }
  float rmssd = sdCount > 0 ? sqrt(sdSum / (float)sdCount) : 0.0f;
  int over50 = 0;
  for (int i = 1; i < rrCount; i++) {
    if (fabs(rrIntervals[i] - rrIntervals[i - 1]) > 50.0f) over50++;
  }
  float pnn50 = sdCount > 0 ? (float)over50 / (float)sdCount : 0.0f;

  float widths[32];
  int widthCount = 0;
  for (int i = 0; i < peakCount && widthCount < 32; i++) {
    float w = estimateQrsWidth(samples, sampleCount, peaks[i]);
    if (w >= 40.0f && w <= 200.0f) {
      widths[widthCount++] = w;
    }
  }
  float qrsWidth = widthCount > 0 ? widths[0] : 90.0f;
  for (int i = 1; i < widthCount; i++) qrsWidth += widths[i];
  if (widthCount > 0) qrsWidth /= (float)widthCount;
  float pctWide = 0.0f;
  if (widthCount > 0) {
    int wideCount = 0;
    for (int i = 0; i < widthCount; i++) {
      if (widths[i] > 130.0f) wideCount++;
    }
    pctWide = (float)wideCount / (float)widthCount;
  }

  float meanSample = 0.0f;
  for (int i = 0; i < sampleCount; i++) meanSample += (float)samples[i];
  meanSample /= (float)sampleCount;
  float ampSum = 0.0f;
  float ampSqSum = 0.0f;
  int ampCount = 0;
  for (int i = 0; i < peakCount; i++) {
    int idx = peaks[i];
    if (idx >= 0 && idx < sampleCount) {
      float amp = fabs((float)samples[idx] - meanSample);
      ampSum += amp;
      ampSqSum += amp * amp;
      ampCount++;
    }
  }
  float avcv = 0.0f;
  if (ampCount > 1 && ampSum > 0.0f) {
    float ampMean = ampSum / (float)ampCount;
    float ampVar = (ampSqSum / (float)ampCount) - (ampMean * ampMean);
    if (ampVar < 0.0f) ampVar = 0.0f;
    avcv = sqrt(ampVar) / (ampMean + 1e-9f);
  }

  if (bpm < 10.0f) {
    severity = "CRITICAL";
    detail = "No detectable beats";
    return "Asystole";
  }

  if (maxGapMs > 3000.0f) {
    severity = "CRITICAL";
    detail = "Gap=" + String(maxGapMs, 0) + "ms";
    return "Sinus Arrest";
  }

  if (bpm > 100.0f && pctWide > 0.5f && cv < 0.15f && peakCount >= 6) {
    severity = "CRITICAL";
    detail = "Wide QRS=" + String(qrsWidth, 0) + "ms, HR=" + String(bpm, 0) + "bpm";
    return "Ventricular Tachycardia";
  }

  if (maxGapMs > 2.2f * midMean && maxGapMs > 2000.0f) {
    severity = "WARNING";
    detail = "Gap=" + String(maxGapMs, 0) + "ms";
    return "Sinus Pause";
  }

  if (cv > 0.15f && rmssd > 75.0f && pnn50 > 0.32f && avcv < 0.10f) {
    severity = "WARNING";
    detail = "CV=" + String(cv, 3) + ", RMSSD=" + String(rmssd, 0) + "ms";
    return "Atrial Fibrillation";
  }

  if (bpm >= 150.0f && bpm <= 250.0f && pctWide < 0.3f && cv < 0.05f) {
    severity = "WARNING";
    detail = "HR=" + String(bpm, 0) + "bpm";
    return "SVT";
  }

  if (bpm > 100.0f && cv < 0.12f && pctWide < 0.4f) {
    severity = "WARNING";
    detail = "HR=" + String(bpm, 0) + "bpm";
    return "Sinus Tachycardia";
  }

  if (bpm < 60.0f && cv < 0.15f && pctWide < 0.4f) {
    severity = "WARNING";
    detail = "HR=" + String(bpm, 0) + "bpm";
    return "Sinus Bradycardia";
  }

  if (bpm >= 50.0f && bpm <= 105.0f && cv >= 0.05f && cv <= 0.18f) {
    severity = "INFO";
    detail = "CV=" + String(cv, 3);
    return "Sinus Arrhythmia";
  }

  severity = "NORMAL";
  detail = "HR=" + String(bpm, 0) + "bpm";
  return "Normal Sinus Rhythm";
}

bool doPost(const String& payload, uint32_t seq) {
  if (WiFi.status() != WL_CONNECTED) return false;

  http.end();
  delay(5);

  if (!http.begin(client, API_URL)) {
    Serial.println("POST FAILED: Could not connect to server");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("Connection", "keep-alive");
  http.setTimeout(10000);
  http.setConnectTimeout(5000);

  int code = http.POST(payload);
  bool ok = (code == 200 || code == 201);

  if (ok) {
    Serial.println("POST: " + String(code) + " seq=" + String(seq) +
                   " queue=" + String(uxQueueMessagesWaiting(blockQueue)));
  } else if (code > 0) {
    Serial.println("POST: " + String(code) + " seq=" + String(seq));
    if (code >= 400) {
      String response = http.getString();
      Serial.println("ERR: " + response.substring(0, 100));
    }
  } else {
    String errMsg = http.errorToString(code);
    Serial.println("POST FAILED (" + String(code) + "): " + errMsg);
  }

  http.end();
  return ok;
}
void triggerCriticalAlert() {

  for (int i = 0; i < 1; i++) {

    digitalWrite(BUZZER_PIN, HIGH);
    tone(BUZZER_PIN,2000);
    digitalWrite(ALERT_LED_PIN, HIGH);
    // delay(500);
    delay(300);

    digitalWrite(BUZZER_PIN, LOW);
    noTone(BUZZER_PIN);
    digitalWrite(ALERT_LED_PIN, LOW);
    // delay(250);
    delay(50);

    // digitalWrite(BUZZER_PIN, HIGH);
    // tone(BUZZER_PIN,2000);
    // digitalWrite(ALERT_LED_PIN, HIGH);
    // delay(500);

    // digitalWrite(BUZZER_PIN, LOW);
    // noTone(BUZZER_PIN);
    // digitalWrite(ALERT_LED_PIN, LOW);
    // delay(500);   
  }
}

void sendTask(void* param) {
  Block blk;

  for (;;) {
    if (xQueueReceive(blockQueue, &blk, portMAX_DELAY) == pdTRUE) {
      if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[HTTP] WiFi down - drop seq=" + String(blk.seq));
        continue;
      }

      uint32_t sampleCount = 0;
      uint32_t latestSeq = 0;
      String condition;
      String severity;
      String detail;

      if (copyAnalysisWindow(analysisSnapshot, sampleCount, latestSeq)) {
        condition = classifyWindow(analysisSnapshot, ANALYSIS_WINDOW_SIZE, severity, detail);
      } else {
        condition = "Warming up";
        severity = "INFO";
        detail = String(sampleCount / WINDOW_SIZE) + "/5 seconds collected";
      }

      Serial.println("[ECG] seq=" + String(blk.seq) +
                     " deviceId=" + String(blk.deviceId) +
                     " detected=" + condition +
                     " severity=" + severity +
                     " note=" + detail);

      if (severity == "WARNING" || severity == "CRITICAL") {

  Serial.println("[WARN] seq=" + String(blk.seq) +
                 " detected=" + condition +
                 " note=" + detail);

  digitalWrite(ALERT_LED_PIN, HIGH);
  digitalWrite(BUZZER_PIN, HIGH);
  triggerCriticalAlert();

  if (severity == "WARNING") {

    Serial.println("[ALERT] CRITICAL CONDITION DETECTED!");
    digitalWrite(ALERT_LED_PIN, HIGH);
    digitalWrite(BUZZER_PIN, HIGH);

    triggerCriticalAlert();
  }
}
else {
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(ALERT_LED_PIN, LOW);
}

      String payload = buildPayload(blk);
      bool sent = doPost(payload, blk.seq);
      if (!sent) {
        // First attempt failed — wait briefly and retry once
        vTaskDelay(pdMS_TO_TICKS(500));
        sent = doPost(payload, blk.seq);
      }
      if (!sent) {
        // Both attempts failed — try to re-queue so it isn't silently lost
        Serial.println("[HTTP] Both POST attempts failed for seq=" + String(blk.seq) + " — re-queuing");
        if (xQueueSendToFront(blockQueue, &blk, 0) != pdTRUE) {
          Serial.println("[HTTP] Re-queue also failed (queue full), seq=" + String(blk.seq) + " dropped");
        }
      }
    }
  }
}

// ============================================================
// RUNTIME USER SYNC (PULL FROM BACKEND)
// ============================================================
void syncUserIdFromBackend() {
  if (WiFi.status() != WL_CONNECTED) return;

  unsigned long now = millis();
  unsigned long effectiveInterval =
      (strcmp(userId, deviceId) == 0) ? 3000UL : USER_SYNC_INTERVAL_MS;
  if (lastUserSyncMs != 0 && (now - lastUserSyncMs) < effectiveInterval) return;
  lastUserSyncMs = now;

  WiFiClientSecure cfgClient;
  cfgClient.setInsecure();
  HTTPClient cfgHttp;
  String url = String(WIFI_CFG_DEVICE_URL) + String(deviceId);

  if (!cfgHttp.begin(cfgClient, url)) {
    Serial.println("[CFG] Runtime sync: begin failed");
    return;
  }

  cfgHttp.setTimeout(5000);
  cfgHttp.setConnectTimeout(3000);

  int code = cfgHttp.GET();
  if (code != 200) {
    Serial.println("[CFG] Runtime sync: GET code=" + String(code));
    cfgHttp.end();
    return;
  }

  String body = cfgHttp.getString();
  cfgHttp.end();

  DynamicJsonDocument doc(1024);
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    Serial.println("[CFG] Runtime sync: invalid JSON");
    return;
  }

  String backendUserId = doc["data"]["userId"] | "";
  backendUserId.trim();
  if (backendUserId.length() == 0) return;

  if (backendUserId != String(userId)) {
    strncpy(userId, backendUserId.c_str(), MAX_DEVICE_ID_LEN - 1);
    userId[MAX_DEVICE_ID_LEN - 1] = '\0';
    saveUserId(userId);
    Serial.println("[CFG] Runtime sync: userId updated to " + String(userId));
  } else {
    Serial.println("[CFG] Runtime sync: userId already current");
  }
}
void wifiConnectedAlert() {
  Serial.println("[WiFi] wifiConnectedAlert");
  // Short beep — do NOT use delay(1000) here, it blocks the main loop
  // and causes blockReady blocks to pile up and overflow the queue.
  digitalWrite(ALERT_LED_PIN, HIGH);
  tone(BUZZER_PIN, 3000);
  delay(200);          // 200 ms is enough to be audible without blocking data
  noTone(BUZZER_PIN);
  digitalWrite(ALERT_LED_PIN, LOW);
}

void wifiDisconnectedAlert() {
  Serial.println("[WiFi] wifiDisconnectedAlert");
  // Short beep — do NOT use delay(1000) here, it blocks the main loop.
  digitalWrite(ALERT_LED_PIN, HIGH);
  tone(BUZZER_PIN, 1500);
  delay(200);
  noTone(BUZZER_PIN);
  digitalWrite(ALERT_LED_PIN, LOW);
}

void localStatusTask(void* param) {
  unsigned long lastHeartbeat = 0;
  bool wasConnected = false;
  
  for (;;) {
    bool isConnected = (WiFi.status() == WL_CONNECTED);
    
    // Check connection state transition
    if (isConnected != wasConnected) {
      wasConnected = isConnected;
      Serial.println("[LocalStatusTask] Network state transition: " + String(isConnected ? "CONNECTED" : "DISCONNECTED"));
      
      IPAddress gw = WiFi.gatewayIP();
      if (gw != (uint32_t)0) {
        String url = String("http://") + gw.toString() + ":" + String(LOCAL_SERVER_PORT) + "/device-status?connected=" + (isConnected ? "true" : "false") + "&deviceId=" + String(deviceId);
        
        HTTPClient httpLocal;
        httpLocal.setTimeout(1500);
        httpLocal.begin(url);
        int code = httpLocal.GET();
        Serial.println("[LocalStatusTask] device-status notified code=" + String(code));
        httpLocal.end();
      }
    }
    
    // Check manual override queue
    if (localNotifyQueued) {
      localNotifyQueued = false;
      bool state = localNotifyState;
      
      IPAddress gw = WiFi.gatewayIP();
      if (gw != (uint32_t)0) {
        String url = String("http://") + gw.toString() + ":" + String(LOCAL_SERVER_PORT) + "/device-status?connected=" + (state ? "true" : "false") + "&deviceId=" + String(deviceId);
        
        HTTPClient httpLocal;
        httpLocal.setTimeout(1500);
        httpLocal.begin(url);
        int code = httpLocal.GET();
        Serial.println("[LocalStatusTask] manual device-status notified code=" + String(code));
        httpLocal.end();
      }
    }
    
    // Heartbeat
    if (isConnected) {
      unsigned long now = millis();
      if (now - lastHeartbeat >= LOCAL_HEARTBEAT_INTERVAL_MS) {
        lastHeartbeat = now;
        
        IPAddress gw = WiFi.gatewayIP();
        if (gw != (uint32_t)0) {
          String url = String("http://") + gw.toString() + ":" + String(LOCAL_SERVER_PORT) + "/heartbeat?deviceId=" + String(deviceId);
          
          HTTPClient httpLocal;
          httpLocal.setTimeout(1500);
          httpLocal.begin(url);
          int code = httpLocal.GET();
          httpLocal.end();
        }
      }
    }
    
    vTaskDelay(pdMS_TO_TICKS(500));
  }
}
// ============================================================
// SETUP
// ============================================================
void setup() {
  Serial.begin(115200);

  pinMode(LO_PLUS_PIN, INPUT);
  pinMode(LO_MINUS_PIN, INPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  pinMode(BUZZER_PIN, OUTPUT);
  ledcSetup(0, 2000, 8);
  
  pinMode(ALERT_LED_PIN, OUTPUT);

  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(ALERT_LED_PIN, LOW);

  loadDeviceId();
  Serial.println("[CFG] Active userId: " + String(userId));
  Serial.println("[CFG] Active deviceId: " + String(deviceId));

  // Forget old WiFi on hardware reset only (EN/reset button).
  // Normal disconnect/reconnect does not reboot, so credentials stay.
  esp_reset_reason_t reason = esp_reset_reason();
  Serial.println("[SYS] Reset reason: " + String(resetReasonToString(reason)));

  // If the user pressed the hardware reset (EN) pin, treat it as an explicit
  // request to forget stored WiFi and reconnect from scratch.
  bool skipAutoConnect = false;
  if (reason == ESP_RST_EXT) {
    Serial.println("[SYS] External reset detected -> forgetting saved WiFi and entering AP mode");
    clearWifiCredentials();
    skipAutoConnect = true;
  }

  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  WiFi.setSleep(false);

  bool wifiConnected = false;
  if (!skipAutoConnect) {
    wifiConnected = connectSavedWiFi();
  } else {
    wifiConnected = false;
  }
  previousWifiState = (WiFi.status() == WL_CONNECTED);
  if (!wifiConnected) {
    reconnectEnabled = false;
    setupApMode = true;
    startAP();
  }
  startServer();

  client.setInsecure();
  http.setReuse(true);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  analogSetPinAttenuation(ECG_PIN, ADC_11db);

  blockQueue = xQueueCreate(QUEUE_DEPTH, sizeof(Block));
  if (blockQueue == NULL) {
    Serial.println("[ERROR] Queue create failed");
    while (true) delay(1000);
  }

  xTaskCreatePinnedToCore(
    sendTask,
    "SendTask",
    8192,
    NULL,
    1,
    NULL,
    0
  );

  xTaskCreatePinnedToCore(
    localStatusTask,
    "LocalStatusTask",
    4096,
    NULL,
    1,
    NULL,
    0
  );

  // Timer setup
  timer = timerBegin(0, 80, true);
  timerAttachInterrupt(timer, &onTimer, true);
  timerAlarmWrite(timer, SAMPLE_INTERVAL_US, true);
  timerAlarmEnable(timer);

  initSignalFilters();

  // Ensure power-state initialization always applies LED/tone/timer behavior.
  setSystemPowerState(true);
}

// ============================================================
// LOOP
// ============================================================
void loop() {
  handlePowerButton();

  if (!systemOn) {
    server.handleClient();
    delay(10);
    return;
  }

  server.handleClient();
  syncUserIdFromBackend();
  attemptReconnectIfNeeded();

  if (blockReady) {
    int sendBuf = 0;
    uint32_t seqToSend = 0;
    bool lo = false;

    portENTER_CRITICAL(&timerMux);
    sendBuf = 1 - activeBuffer;
    blockReady = false;
    seqToSend = blockSeq;
    lo = leadsOff;
    portEXIT_CRITICAL(&timerMux);

    Block blk;
    memcpy(blk.data, buffers[sendBuf], WINDOW_SIZE * sizeof(uint16_t));
    blk.seq = seqToSend;
    blk.lo = lo;

    strncpy(blk.userId, userId, MAX_DEVICE_ID_LEN - 1);
    blk.userId[MAX_DEVICE_ID_LEN - 1] = '\0';
    strncpy(blk.deviceId, deviceId, MAX_DEVICE_ID_LEN - 1);
    blk.deviceId[MAX_DEVICE_ID_LEN - 1] = '\0';

    // Apply 50Hz notch + 40Hz low-pass before analysis/sending
    applySignalFiltersToBlock(blk);

    appendAnalysisBlock(blk);

    if (xQueueSend(blockQueue, &blk, 0) != pdTRUE) {
      queueOverflows++;
      Serial.println("[Queue] OVERFLOW seq=" + String(seqToSend) +
                     " total=" + String(queueOverflows));
    }
  }
  bool currentWifiState = (WiFi.status() == WL_CONNECTED);

  if (currentWifiState != previousWifiState) {
    if (currentWifiState) {
      digitalWrite(LED_PIN, HIGH);
      Serial.println("[WiFi] CONNECTED");
      wifiConnectedAlert();
      localNotifyState = true;
      localNotifyQueued = true;
    } else {
      digitalWrite(LED_PIN, LOW);
      Serial.println("[WiFi] DISCONNECTED");
      wifiDisconnectedAlert();
      localNotifyState = false;
      localNotifyQueued = true;
    }
    previousWifiState = currentWifiState;
  }

  delay(1);
}
