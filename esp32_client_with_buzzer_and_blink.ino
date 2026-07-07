/*
 * ESP32 ECG v8.1 — Flutter Controlled WiFi Config (Stable Version)
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
#define BUZZER_PIN 4
#define ALERT_LED_PIN 26

// -------------------- GLOBALS --------------------
WebServer server(80);
Preferences prefs;

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

QueueHandle_t blockQueue = NULL;
uint32_t queueOverflows = 0;

unsigned long lastUserSyncMs = 0;
const unsigned long USER_SYNC_INTERVAL_MS = 15000;

String reconnectSsid = "";
String reconnectPass = "";
bool hasReconnectCreds = false;
unsigned long lastReconnectAttemptMs = 0;
const unsigned long RECONNECT_INTERVAL_MS = 5000;

// Timer
hw_timer_t *timer = NULL;
portMUX_TYPE timerMux = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE analysisMux = portMUX_INITIALIZER_UNLOCKED;

// ============================================================
// TIMER ISR (Perfect 360Hz)
// ============================================================
void IRAM_ATTR onTimer() {
  portENTER_CRITICAL_ISR(&timerMux);

  leadsOff = (digitalRead(LO_PLUS_PIN) == HIGH ||
              digitalRead(LO_MINUS_PIN) == HIGH);

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
    return true;
  }

  Serial.println("\n[WiFi] Saved network failed, will use AP mode");
  return false;
}

void attemptReconnectIfNeeded() {
  if (WiFi.status() == WL_CONNECTED) return;

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
  } else {
    Serial.println("\nFailed! Restarting AP...");
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

  float threshold = maxAbs * 0.45f;
  int peakCount = 0;
  int minDistance = SAMPLE_RATE / 4;
  int lastPeak = -minDistance;

  for (int i = 1; i < sampleCount - 1; i++) {
    if (analysisCentered[i] < threshold) continue;
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

  if (maxGapMs > 1.6f * midMean && maxGapMs > 1400.0f) {
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

  for (int i = 0; i < 40; i++) {

    digitalWrite(BUZZER_PIN, HIGH);
    tone(BUZZER_PIN,2000);
    digitalWrite(ALERT_LED_PIN, HIGH);
    delay(500);

    digitalWrite(BUZZER_PIN, LOW);
    noTone(BUZZER_PIN);
    digitalWrite(ALERT_LED_PIN, LOW);
    delay(250);

    digitalWrite(BUZZER_PIN, HIGH);
    tone(BUZZER_PIN,2000);
    digitalWrite(ALERT_LED_PIN, HIGH);
    delay(500);

    digitalWrite(BUZZER_PIN, LOW);
    noTone(BUZZER_PIN);
    digitalWrite(ALERT_LED_PIN, LOW);
    delay(500);   
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
  digitalWrite(ALERT_LED_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);
}

      String payload = buildPayload(blk);
      if (!doPost(payload, blk.seq)) {
        vTaskDelay(pdMS_TO_TICKS(250));
        doPost(payload, blk.seq);
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

// ============================================================
// SETUP
// ============================================================
void setup() {
  Serial.begin(115200);

  pinMode(LO_PLUS_PIN, INPUT);
  pinMode(LO_MINUS_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  pinMode(BUZZER_PIN, OUTPUT);
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
  if (reason == ESP_RST_EXT || reason == ESP_RST_POWERON) {
    Serial.println("[SYS] Reset detected -> forgetting old WiFi");
    clearWifiCredentials();
  }

  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  WiFi.setSleep(false);

  bool wifiConnected = connectSavedWiFi();
  if (!wifiConnected) {
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

  // Timer setup
  timer = timerBegin(0, 80, true);
  timerAttachInterrupt(timer, &onTimer, true);
  timerAlarmWrite(timer, SAMPLE_INTERVAL_US, true);
  timerAlarmEnable(timer);
}

// ============================================================
// LOOP
// ============================================================
void loop() {
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

    appendAnalysisBlock(blk);

    if (xQueueSend(blockQueue, &blk, 0) != pdTRUE) {
      queueOverflows++;
      Serial.println("[Queue] OVERFLOW seq=" + String(seqToSend) +
                     " total=" + String(queueOverflows));
    }
  }

  delay(1);
}