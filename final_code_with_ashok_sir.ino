/*
 * ESP32 ECG v9.4 — Zero-Phase Compatible Linear Pipeline
 * (v8.3: fixed post-QRS baseline ripple; v8.4: restored P/T wave
 *  amplitude; v8.5: smoothstep baseline interpolation to remove the
 *  residual anchor-update ripple; v8.6: 4x ADC oversampling in the
 *  timer ISR to reduce WiFi-radio EMI coupled into the ADC; v8.7:
 *  polarity-agnostic QRS/P/T detection; v8.8: fixed a compile error
 *  from struct WaveMeasurement being defined after Arduino's
 *  auto-generated function prototypes needed it; v8.9: baseline
 *  contamination gate; v9.0: replaced the IIR biquad low-pass with a
 *  zero-phase FIR moving-average to eliminate ringing structurally;
 *  v9.1: resized that FIR filter (was over-smoothing Q/S) to
 *  correctly hit a 40Hz cutoff; v9.2: notch Q 3->2, measured settling
 *  time 50ms->42ms — this is the last remaining pole-based filter in
 *  the chain, so the last thing that can still ring at all. Q wasn't
 *  pushed lower than 2 because the widened notch band starts to
 *  overlap Q/S-relevant frequencies past that point; v9.3: buzzer
 *  moved from tone()/noTone() to LEDC PWM so loudness is a real,
 *  adjustable duty cycle (BUZZER_VOLUME_DUTY) instead of tone()'s
 *  fixed full-volume square wave — targets Arduino-ESP32 core 2.0.x
 *  channel-based LEDC API (ledcSetup/ledcAttachPin/ledcWriteTone(channel,..));
 *  v9.4: alert beep COUNT now reflects severity — WARNING beeps once,
 *  CRITICAL beeps twice — instead of the inverted WARNING-beeps-twice
 *  logic from before. triggerCriticalAlert() takes a beepCount param
 *  instead of a dead single-iteration for-loop. Removed two genuinely
 *  unused locals (minGapMs, rrMid) that were computed in classifyWindow()
 *  but never read, which were silent dead-code/compiler-warning sources;
 *  v9.5: leadsOff used to OR LO_PLUS_PIN and LO_MINUS_PIN into a single
 *  bool, so a disconnected RA (LO+) electrode and a disconnected LA
 *  (LO-) electrode were indistinguishable everywhere downstream. Now
 *  tracked as two separate volatiles (loPlusOff/loMinusOff), carried
 *  per-block, and reported by name in the Serial/backend log — leadsOff
 *  itself is kept as their OR for existing filter-reset/validation logic,
 *  so no other behavior changes.)
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
// ESP32's ADC picks up EMI from its own WiFi radio while transmitting —
// well documented on this chip. That shows up as a small, fairly uniform
// ripple across the whole waveform (not just after the QRS), which is
// exactly what v8.5's screenshot showed. Averaging several raw
// conversions per output sample, right at acquisition, knocks this down
// by roughly sqrt(N) without adding lag or touching any filter design —
// output stays locked at 360Hz either way.
#define ADC_OVERSAMPLE_N 4
#define BUZZER_PIN 33
#define ALERT_LED_PIN 26
#define POWER_SENSE_PIN 34
#define BUTTON_PIN 27

// --------- Buzzer volume control (v9.3) ---------
// tone()/noTone() only control PITCH (square-wave frequency) — a plain
// digitalWrite/tone-driven buzzer has no concept of "volume" in software,
// it's either full-amplitude-on or off. To actually get a quiet buzzer,
// the pin is driven through the ESP32's LEDC PWM peripheral instead: the
// PWM *duty cycle* becomes a real, adjustable loudness control (low duty
// = short current pulses = quieter click; ~50% duty = normal tone()-like
// loudness). BUZZER_LEDC_CHANNEL reuses the LEDC channel/resolution that
// was already reserved via ledcSetup(0, 2000, 8) in setup() but, before
// this version, was never attached to a pin and therefore did nothing.
#define BUZZER_LEDC_CHANNEL 0
#define BUZZER_LEDC_RESOLUTION_BITS 8      // matches ledcSetup(0, 2000, 8) below
#define BUZZER_VOLUME_DUTY 30               // 0-255 scale; ~12% duty = quiet. Raise toward ~40-60 for a bit louder, ~120-160 for a "normal" tone()-like level.

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
  bool loPlus;   // v9.5: RA (LO+) electrode disconnected this block
  bool loMinus;  // v9.5: LA (LO-) electrode disconnected this block
  char userId[MAX_DEVICE_ID_LEN];
  char deviceId[MAX_DEVICE_ID_LEN];
};

// Defined here (not down near measurePWave/measureTWave where it's used)
// because the Arduino builder auto-generates function prototypes near the
// top of the translation unit, before it has parsed the rest of the file.
// A prototype referencing this struct as a return type would fail to
// compile ("does not name a type") if the struct were defined any later.
struct WaveMeasurement {
  bool valid;
  float amplitude;    // ADC counts, signed, relative to the local isoelectric (TP/ST) reference
  float timeMsFromR;  // negative = before R (P), positive = after R (T)
};

uint16_t buffers[2][WINDOW_SIZE];
uint16_t analysisWindow[ANALYSIS_WINDOW_SIZE];
uint16_t analysisSnapshot[ANALYSIS_WINDOW_SIZE];
float analysisCentered[ANALYSIS_WINDOW_SIZE];

volatile int activeBuffer = 0;
volatile int sampleIndex = 0;
volatile bool blockReady = false;
volatile bool leadsOff = false;
// v9.5: leadsOff (above) stays as the OR of both, unchanged, so existing
// filter-reset/validation code keeps working. These two track each
// electrode individually so the specific disconnected lead can be
// identified and reported instead of just "leads off" in general.
volatile bool loPlusOff = false;
volatile bool loMinusOff = false;
volatile uint32_t blockSeq = 0;
volatile uint32_t analysisWriteIndex = 0;
volatile uint32_t analysisSampleCount = 0;
volatile uint32_t analysisLatestSeq = 0;

// --------- 0.5Hz Linear High-Pass filter state 
static float hp_s1 = 0.0f;
static float hp_s2 = 0.0f;
static float hp_b0 = 1.0f, hp_b1 = 0.0f, hp_b2 = 0.0f;
static float hp_a1 = 0.0f, hp_a2 = 0.0f;
static bool hp_initialized = false;

// --------- 50Hz Notch filter state
static float notch_s1 = 0.0f;
static float notch_s2 = 0.0f;
static float notch_b0 = 1.0f, notch_b1 = 0.0f, notch_b2 = 0.0f;
static float notch_a1 = 0.0f, notch_a2 = 0.0f;
static bool notch_initialized = false;

// --------- 40Hz Low-pass: zero-phase FIR moving-average (double pass) ---------
// v9.0: replaced the IIR biquad low-pass with this. An IIR filter has
// poles — it physically can ring when hit by a sharp transient like the
// QRS edge, which is a plausible source of the residual wiggle that kept
// showing up between S and T even after every other fix. An FIR moving
// average has no poles, so it cannot ring, by construction — not "less
// ringing," zero. Applied as two passes (box filter convolved with
// itself = triangular window) for better frequency selectivity than a
// single boxcar, still fully linear-phase since each pass is symmetric.
// v9.1: was 9 taps. Measured (not guessed) the actual frequency response
// of the double-pass cascade — 9 taps x2 passes cuts off at 12.8Hz
// (44ms effective support), which is what was rounding off Q and S:
// they're the narrowest, fastest deflections in the whole waveform and
// need bandwidth close to 40Hz to stay sharp. 3 taps x2 passes measures
// out to -3dB at 40.4Hz (11ms support) — matches the original 40Hz
// design intent almost exactly, while staying a double pass (still
// zero-pole/ringless, still better sidelobe suppression than one boxcar).
#define LP_MOVING_AVG_WIN 3

// --------- Median (spike) filter state
static uint16_t median_prev1 = 2048;

// --------- Baseline wander removal (two-stage median) state ---------
// A linear high-pass filter reacts to the sharp QRS transient like an
// impulse and "rings"/decays afterward — that decay is exactly the
// downward droop that was showing up right after the QRS and getting
// mistaken for an inverted T-wave. A median filter is robust to brief
// outliers (the QRS is brief relative to these window sizes), so it
// tracks the slow baseline wander WITHOUT reacting to the QRS at all.
//
// v8.3 FIX: stage-1 window was 40 samples (111ms) — too close to a real
// QRS duration (80-160ms). When the QRS landed mostly inside one 111ms
// chunk, the median of that chunk was QRS-biased instead of baseline,
// producing a bad anchor point. That anchor got linearly interpolated
// into the next chunk, which is exactly the ~9Hz post-QRS "vibration"
// and flattened/inverted-looking T-wave that was being reported. Fixed
// by (1) widening stage-1 to ~200ms — the standard Sörnmo/Laguna sizing,
// comfortably wider than even a wide/bundle-branch-block QRS (<=160ms),
// so QRS occupies well under half the window and the median ignores it,
// and (2) a physiological slew-rate clamp on the anchor itself as a
// second safety net: true baseline wander is <0.5Hz and simply cannot
// move faster than a few tens of counts per 200ms, so any larger jump
// is QRS/T leakage and gets clamped rather than injected into the trace.
//
// v8.4 FIX: stage-2 was left at only 3 candidates. A median of 3 gives
// essentially no outlier rejection — if a single stage-1 candidate landed
// mostly on the P or T wave (a slow bump, not a brief spike like the
// QRS), that candidate became the "baseline" and got subtracted straight
// back out, which is why P/T were flattening out. Widened to 5 candidates:
// a median of 5 can reject up to 2 contaminated candidates while still
// passing through the true flat (isoelectric) baseline, so a P- or
// T-wave-affected candidate is correctly rejected instead of removed.
#define BL_STAGE1_WIN       72                               // ~200ms — reliably wider than QRS (incl. wide/BBB QRS up to ~160ms)
#define BL_CANDS_PER_BLOCK  (WINDOW_SIZE / BL_STAGE1_WIN)     // 360/72 = 5 candidates/block
#define BL_STAGE2_WIN       5                                 // 5 candidates * 200ms = ~1000ms span — robustly rejects a single P/T-contaminated candidate (median-of-5 tolerates up to 2 outliers) instead of absorbing P/T into the baseline
#define BL_HISTORY_LEN      16                                // ring buffer, must be > BL_STAGE2_WIN
#define BL_MAX_STEP_PER_CAND 80.0f                            // ADC counts/200ms slew limit — real wander is far slower than this; anything faster is QRS/T leakage and gets clamped
#define BL_CONTAM_PTP_THRESHOLD 250.0f                        // ADC counts peak-to-peak within one 200ms stage-1 chunk. True baseline wander (<0.5Hz) cannot swing this much in 200ms; a chunk that does contains a QRS/S-wave edge (or a large T) and must not be allowed to bias the anchor at all

static float blStage1History[BL_HISTORY_LEN];
static int   blHistoryCount = 0;
static int   blHistoryHead  = 0;
static float blLastAnchor   = 2048.0f;
static bool  blInitialized  = false;


// globals, near queueOverflows
static String lastAlertCondition = "";
static unsigned long lastAlertMs = 0;
const unsigned long ALERT_COOLDOWN_MS = 8000; // same condition re-beep nahi karse 8s sudhi


// --------- Working float buffer 
static float workBuf[WINDOW_SIZE];
#define DC_RECENTER 2048.0f


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
hw_timer_t* timer = NULL;
portMUX_TYPE timerMux = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE analysisMux = portMUX_INITIALIZER_UNLOCKED;

// ============================================================
// BUZZER (v9.3: PWM-duty volume control)
// ============================================================
// Drives BUZZER_PIN through the LEDC PWM peripheral instead of the
// Arduino tone()/noTone() pair. tone() always toggles the pin between
// full 0V/3.3V at ~50% duty, i.e. maximum loudness at whatever frequency
// you give it — there is no "quiet tone()" call. LEDC gives independent
// control of frequency (ledcWriteTone) AND duty cycle (ledcWrite), and
// duty cycle is what a piezo buzzer's perceived loudness actually tracks:
// a low duty cycle delivers short current pulses per cycle instead of a
// full square wave, which comes out audibly much quieter at the same
// frequency. BUZZER_VOLUME_DUTY is the single place that sets the level
// for every beep/alert in this firmware.
void buzzerOn(int freq) {
  ledcWriteTone(BUZZER_LEDC_CHANNEL, freq);
  ledcWrite(BUZZER_LEDC_CHANNEL, BUZZER_VOLUME_DUTY);
}

void buzzerOff() {
  ledcWrite(BUZZER_LEDC_CHANNEL, 0);
  ledcWriteTone(BUZZER_LEDC_CHANNEL, 0);
}

void beepTone(int freq, int durationMs) {
  buzzerOn(freq);
  delay(durationMs);
  buzzerOff();
}

void turnWifiOff() {
  reconnectEnabled = false;
  setupApMode = true;
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(false, false);
  WiFi.mode(WIFI_OFF);
  digitalWrite(LED_PIN, LOW);
}

void startAP();

void turnWifiOn() {
  String ssid;
  String password;
  bool hasCreds = hasReconnectCreds || loadWifiCredentials(ssid, password);

  if (hasCreds) {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.persistent(true);
    WiFi.setSleep(false);
    reconnectEnabled = true;
    setupApMode = false;

    if (!hasReconnectCreds) {
      reconnectSsid = ssid;
      reconnectPass = password;
      hasReconnectCreds = true;
    }
    WiFi.begin(reconnectSsid.c_str(), reconnectPass.c_str());
  } else {
    reconnectEnabled = false;
    setupApMode = true;
    startAP();
  }
}

void setSystemPowerState(bool on) {
  systemOn = on;

  if (systemOn) {
    if (timer != NULL) {
      timerAlarmEnable(timer);
    }
    Serial.println("[SYS] ECG SYSTEM ON");
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
    digitalWrite(ALERT_LED_PIN, HIGH);
    delay(120);
    digitalWrite(ALERT_LED_PIN, LOW);
    buzzerOff();
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

  if (currentButtonState == LOW && !longPressHandled && (now - buttonPressStartMs) >= BUTTON_HOLD_MS) {
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
  bool loPlusHigh = (digitalRead(LO_PLUS_PIN) == HIGH);
  bool loMinusHigh = (digitalRead(LO_MINUS_PIN) == HIGH);
  loPlusOff = loPlusHigh;
  loMinusOff = loMinusHigh;
  leadsOff = (loPlusHigh || loMinusHigh);

  if (leadsOff) {
    buffers[activeBuffer][sampleIndex] = 0;
  } else {
    // Oversample + average: reduces WiFi-radio EMI coupled into the ADC
    // (incoherent noise averages down ~sqrt(N)) without adding lag —
    // still one output sample at the same 360Hz rate.
    uint32_t acc = 0;
    for (int k = 0; k < ADC_OVERSAMPLE_N; k++) {
      acc += analogRead(ECG_PIN);
    }
    buffers[activeBuffer][sampleIndex] = (uint16_t)(acc / ADC_OVERSAMPLE_N);
  }
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
    if (strlen(userId) == 0) {
      strncpy(userId, deviceId, MAX_DEVICE_ID_LEN - 1);
      userId[MAX_DEVICE_ID_LEN - 1] = '\0';
      saveUserId(userId);
    }
  }

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

  server.send(200, "application/json", "{\"status\":\"connecting\"}");
  delay(2000);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), password.c_str());

  Serial.println("Connecting to WiFi...");
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
    startAP();
    return;
  }

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
  json += "\"loPlus\":" + String(blk.loPlus ? "true" : "false") + ",";
  json += "\"loMinus\":" + String(blk.loMinus ? "true" : "false") + ",";
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


// ============================================================
// FILTERING PIPELINE 
// ============================================================

void resetSignalFilterState() {
  hp_s1 = 0.0f;
  hp_s2 = 0.0f;
  notch_s1 = 0.0f;
  notch_s2 = 0.0f;
  median_prev1 = 2048;
  blHistoryCount = 0;
  blHistoryHead  = 0;
  blLastAnchor   = 2048.0f;
  blInitialized  = false;
}

void initHighPass0p5Hz(float fs = (float)SAMPLE_RATE, float f0 = 0.5f) {
  double Q = 0.7071067811865476;  
  double w0 = 2.0 * PI * (double)f0 / (double)fs;
  double cos_w0 = cos(w0);
  double alpha = sin(w0) / (2.0 * Q);

  double b0 = (1.0 + cos_w0) / 2.0;
  double b1 = -(1.0 + cos_w0);
  double b2 = (1.0 + cos_w0) / 2.0;
  double a0 = 1.0 + alpha;
  double a1 = -2.0 * cos_w0;
  double a2 = 1.0 - alpha;

  hp_b0 = (float)(b0 / a0);
  hp_b1 = (float)(b1 / a0);
  hp_b2 = (float)(b2 / a0);
  hp_a1 = (float)(a1 / a0);
  hp_a2 = (float)(a2 / a0);
  hp_s1 = 0.0f;
  hp_s2 = 0.0f;
  hp_initialized = true;
}

// v9.2: Q lowered 3 -> 2. This is the last pole-based (IIR) filter left
// in the chain, so it's the last thing that can still ring on the QRS
// edge — measured settling time drops from 50ms to 42ms at Q=2. A digital
// notch always has an exact null at f0 regardless of Q (rejection AT
// 50Hz is unaffected), but lower Q widens the notch band around it
// (~37.5-62.5Hz here), which is why this wasn't pushed lower: Q=1.5 or
// below starts to clearly overlap the same 37-45Hz range Q/S sharpness
// depends on, undoing the LP fix from v9.1.
void initNotch50Hz(float fs, float f0 = 50.0f, float Q = 2.0f) {
  float w0 = 2.0f * PI * f0 / fs;
  float cos_w0 = cos(w0);
  float alpha = sin(w0) / (2.0f * Q);

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

void initSignalFilters() {
  // Median-based baseline removal doesn't need pre-computed coefficients
  // like the linear filters do — its state is reset via resetSignalFilterState().
  initNotch50Hz((float)SAMPLE_RATE);
  // Low-pass is now an FIR moving average (see applyLowPassToBlock) —
  // no coefficients to precompute, no state to carry between blocks.
  median_prev1 = 2048;
  
  Serial.println("[FILTER] Median baseline removal + Notch 50Hz (Q=2) + zero-phase FIR LP (double-pass moving avg) enabled");
}

void applyHighPassToBlock(float* data, int len) {
  if (!hp_initialized) initHighPass0p5Hz();
  for (int i = 0; i < len; i++) {
    float x = data[i];
    float y = hp_b0 * x + hp_s1;
    hp_s1 = hp_b1 * x - hp_a1 * y + hp_s2;
    hp_s2 = hp_b2 * x - hp_a2 * y;
    data[i] = y; 
  }
}

// Small insertion-sort median — fine for the tiny N used here (<=40).
static float medianOfFloats(float* tmp, int n) {
  for (int i = 1; i < n; i++) {
    float key = tmp[i]; int j = i - 1;
    while (j >= 0 && tmp[j] > key) { tmp[j + 1] = tmp[j]; j--; }
    tmp[j + 1] = key;
  }
  return (n % 2 == 1) ? tmp[n / 2] : 0.5f * (tmp[n / 2 - 1] + tmp[n / 2]);
}

// Removes baseline wander in place, WITHOUT reacting to the QRS transient
// (unlike a linear high-pass). Stage 1 takes one coarse median per ~200ms
// chunk (wide enough that a QRS — even a wide one — occupies well under
// half the samples in it, so the median genuinely ignores it instead of
// being biased toward it). Stage 2 median-smooths those candidates against
// 5 candidates of recent history (~1000ms) — a median of 5 can reject up
// to 2 contaminated candidates, which is what actually lets a P- or
// T-wave-affected chunk be correctly rejected as an outlier instead of
// being absorbed into the "baseline" and subtracted back out (too few
// stage-2 candidates was flattening P/T; too wide a stage-1 window would
// let it eat P/T directly — 200ms/5-candidates keeps both QRS and P/T
// intact). A slew-rate clamp on the anchor is a second safety net: true
// baseline wander is <0.5Hz and can't move faster than a few tens of
// counts per 200ms, so any larger jump is residual QRS/T leakage and gets
// clamped instead of injected into the trace. The result is linearly
// interpolated for a smooth, continuous, per-sample baseline estimate
// that's subtracted from data[].
void removeBaselineWander(float* data, int len) {
  float tmp1[BL_STAGE1_WIN];
  float tmp2[BL_STAGE2_WIN];

  for (int c = 0; c < BL_CANDS_PER_BLOCK; c++) {
    int lo = c * BL_STAGE1_WIN;
    int hi = min(len, lo + BL_STAGE1_WIN);
    if (hi <= lo) break;
    int n1 = hi - lo;

    for (int i = 0; i < n1; i++) tmp1[i] = data[lo + i];

    // Contamination gate: if this chunk's peak-to-peak range is far
    // beyond what baseline wander could physically produce in 200ms, a
    // QRS/S-wave edge (or a large T) is sitting in this chunk. Don't let
    // its median into the anchor history at all — just hold the last
    // known-good anchor steady through it. This is what was producing
    // the extra dip right before T: a contaminated chunk was still
    // dragging the anchor down for one update, then correcting back up.
    float chunkMin = tmp1[0], chunkMax = tmp1[0];
    for (int i = 1; i < n1; i++) {
      if (tmp1[i] < chunkMin) chunkMin = tmp1[i];
      if (tmp1[i] > chunkMax) chunkMax = tmp1[i];
    }
    bool contaminated = (chunkMax - chunkMin) > BL_CONTAM_PTP_THRESHOLD;

    float anchor;
    if (!contaminated) {
      float cand = medianOfFloats(tmp1, n1);

      blStage1History[blHistoryHead] = cand;
      blHistoryHead = (blHistoryHead + 1) % BL_HISTORY_LEN;
      if (blHistoryCount < BL_HISTORY_LEN) blHistoryCount++;

      int n2 = min(blHistoryCount, BL_STAGE2_WIN);
      for (int i = 0; i < n2; i++) {
        int idx = (blHistoryHead - 1 - i + BL_HISTORY_LEN) % BL_HISTORY_LEN;
        tmp2[i] = blStage1History[idx];
      }
      anchor = medianOfFloats(tmp2, n2);
    } else {
      anchor = blLastAnchor;  // hold steady — do not let a contaminated chunk move the baseline
    }

    if (!blInitialized) {
      blLastAnchor = anchor;
      blInitialized = true;
    } else {
      // Slew-rate clamp: reject anchor jumps faster than real baseline
      // wander could physically produce (guards against any residual
      // QRS/T bias that slips past the median stages).
      float delta = anchor - blLastAnchor;
      if (delta > BL_MAX_STEP_PER_CAND) anchor = blLastAnchor + BL_MAX_STEP_PER_CAND;
      else if (delta < -BL_MAX_STEP_PER_CAND) anchor = blLastAnchor - BL_MAX_STEP_PER_CAND;
    }

    for (int i = 0; i < n1; i++) {
      float frac = (float)(i + 1) / (float)n1;
      // Smoothstep instead of linear: linear interpolation is continuous
      // in value but its slope snaps to a new angle at every anchor
      // update (~200ms) — that corner injects a small burst of
      // high-frequency energy right where the anchor is moving fastest,
      // which is exactly the neighborhood of the QRS. Smoothstep eases
      // the slope in/out instead, at zero extra runtime cost.
      float smooth = frac * frac * (3.0f - 2.0f * frac);
      float baseline = blLastAnchor + smooth * (anchor - blLastAnchor);
      data[lo + i] -= baseline;
    }
    blLastAnchor = anchor;
  }
}

void applyNotchToBlock(float* data, int len) {
  if (!notch_initialized) initNotch50Hz((float)SAMPLE_RATE);
  for (int i = 0; i < len; i++) {
    float x = data[i];
    float y = notch_b0 * x + notch_s1;
    notch_s1 = notch_b1 * x - notch_a1 * y + notch_s2;
    notch_s2 = notch_b2 * x - notch_a2 * y;
    data[i] = y; 
  }
}

// One centered (zero-phase) moving-average pass. Centered means it uses
// samples on both sides of i within this block, not just past samples —
// that's what makes it zero-phase (no lag/shift) rather than a causal
// filter that would delay the signal.
static void movingAveragePass(const float* in, float* out, int len) {
  for (int i = 0; i < len; i++) {
    float sum = 0.0f;
    int count = 0;
    for (int j = -LP_MOVING_AVG_WIN / 2; j <= LP_MOVING_AVG_WIN / 2; j++) {
      int idx = i + j;
      if (idx >= 0 && idx < len) {
        sum += in[idx];
        count++;
      }
    }
    out[i] = sum / (float)count;
  }
}

// v9.0: FIR moving average replaces the old IIR biquad low-pass. An IIR
// filter has poles, which is exactly what lets it ring when hit by a
// sharp transient like the QRS edge — plausibly the source of ringing
// that persisted even after the notch and baseline fixes. An FIR filter
// has no poles, so it cannot ring, by construction. Run as two passes
// (a box filter convolved with itself = a triangular window) for better
// frequency selectivity than a single boxcar; still exactly linear-phase
// since each pass is symmetric, so no new lag is introduced either.
void applyLowPassToBlock(float* data, int len) {
  float temp[WINDOW_SIZE];
  movingAveragePass(data, temp, len);
  movingAveragePass(temp, data, len);
}

void applyMedianToBlock(uint16_t* data, int len) {
  uint16_t prev = median_prev1;
  for (int i = 0; i < len; i++) {
    uint16_t cur  = data[i];
    uint16_t next = (i < len - 1) ? data[i + 1] : cur;
    uint16_t a = prev, b = cur, c = next;
    
    if (a > b) { uint16_t t = a; a = b; b = t; }
    if (b > c) { uint16_t t = b; b = c; c = t; }
    if (a > b) { uint16_t t = a; a = b; b = t; }
    
    prev = data[i];
    data[i] = b; 
  }
  median_prev1 = prev;
}

void applySignalFiltersToBlock(Block& blk) {
  if (blk.lo) {
    resetSignalFilterState();
    // v9.5: name the specific disconnected electrode(s) instead of a
    // generic "leads off" — RA is the LO+ input, LA is the LO- input.
    String leadMsg;
    if (blk.loPlus && blk.loMinus) leadMsg = "RA (LO+) and LA (LO-)";
    else if (blk.loPlus) leadMsg = "RA (LO+)";
    else if (blk.loMinus) leadMsg = "LA (LO-)";
    else leadMsg = "unknown";
    Serial.println("[FILTER] Leads off -> filter state reset (" + leadMsg + " disconnected)");
    return;
  }

  // 1. Hardware Despike (median-of-3) to catch stray static spikes
  applyMedianToBlock(blk.data, WINDOW_SIZE);

  // Move to float working buffer 
  for (int i = 0; i < WINDOW_SIZE; i++) workBuf[i] = (float)blk.data[i];

  // 2. Baseline wander removal (median-based — robust to the QRS
  //    transient, so it doesn't produce the post-QRS droop that a linear
  //    high-pass does)
  removeBaselineWander(workBuf, WINDOW_SIZE);

  // 3. 50Hz Notch
  applyNotchToBlock(workBuf, WINDOW_SIZE);

  // 4. Zero-phase FIR low-pass (double-pass moving average) — cannot ring, unlike the IIR biquad it replaced
  applyLowPassToBlock(workBuf, WINDOW_SIZE);

  // 5. Re-center + clamp
  for (int i = 0; i < WINDOW_SIZE; i++) {
    float y = workBuf[i] + DC_RECENTER;
    if (y < 0.0f) y = 0.0f;
    if (y > 4095.0f) y = 4095.0f;
    blk.data[i] = (uint16_t)y;
  }
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
  float threshold = maxAbs * 0.50f;
  int peakCount = 0;
  int minDistance = SAMPLE_RATE / 4;
  int lastPeak = -minDistance;

  // Polarity-agnostic: QRS direction depends on lead vector vs. an
  // individual's cardiac axis, so the same electrode placement can be
  // upright on one person and inverted on another (both are normal).
  // Detect the largest-magnitude local extremum either way, not just
  // positive peaks, or an inverted QRS is missed entirely.
  for (int i = 1; i < sampleCount - 1; i++) {
    float v = analysisCentered[i];
    float av = fabs(v);
    if (av < threshold) continue;

    bool isLocalExtreme = (v > 0.0f)
      ? (v >= analysisCentered[i - 1] && v > analysisCentered[i + 1])
      : (v <= analysisCentered[i - 1] && v < analysisCentered[i + 1]);
    if (!isLocalExtreme) continue;
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

  float halfLevel = localMin + 0.50f * (localMax - localMin);
  // Polarity-aware: an inverted QRS sits below halfLevel at rIndex, so the
  // boundary search has to walk outward while values stay BELOW halfLevel,
  // not above — otherwise the while-loop below exits immediately (0-width).
  bool negativePeak = ((float)samples[rIndex] < halfLevel);

  int left = rIndex;
  int right = rIndex;
  if (!negativePeak) {
    while (left > start && (float)samples[left] > halfLevel) left--;
    while (right < end && (float)samples[right] > halfLevel) right++;
  } else {
    while (left > start && (float)samples[left] < halfLevel) left--;
    while (right < end && (float)samples[right] < halfLevel) right++;
  }

  float widthSamples = (float)max(1, right - left);
  return (widthSamples / (float)SAMPLE_RATE) * 1000.0f;
}

// Same half-amplitude-crossing technique as estimateQrsWidth(), but returns
// the actual onset/offset sample indices instead of just a width. Used as
// the reference points for P- and T-wave search windows below (P is
// searched before qOnsetIdx, T is searched after sOffsetIdx) so both
// waves are located relative to this beat's real QRS boundaries rather
// than a fixed offset from R.
void findQrsBoundaries(const uint16_t* samples, int sampleCount, int rIndex, int& qOnsetIdx, int& sOffsetIdx) {
  int searchRadius = (int)(0.07f * SAMPLE_RATE);
  int start = max(0, rIndex - searchRadius);
  int end = min(sampleCount - 1, rIndex + searchRadius);
  qOnsetIdx = start;
  sOffsetIdx = end;
  if (end <= start) return;

  float localMax = 0.0f, localMin = 1e9f;
  for (int i = start; i <= end; i++) {
    float v = (float)samples[i];
    if (v > localMax) localMax = v;
    if (v < localMin) localMin = v;
  }
  float halfLevel = localMin + 0.50f * (localMax - localMin);
  bool negativePeak = ((float)samples[rIndex] < halfLevel);

  int left = rIndex;
  int right = rIndex;
  if (!negativePeak) {
    while (left > start && (float)samples[left] > halfLevel) left--;
    while (right < end && (float)samples[right] > halfLevel) right++;
  } else {
    while (left > start && (float)samples[left] < halfLevel) left--;
    while (right < end && (float)samples[right] < halfLevel) right++;
  }

  qOnsetIdx = left;
  sOffsetIdx = right;
}

// P wave: search the TP segment before this beat's QRS onset for the
// largest deflection (either direction — P polarity isn't guaranteed to
// match QRS polarity, so this stays magnitude-based like the T-wave
// search below). Window covers the normal PR-interval range (up to
// 280ms before R) while stopping short of QRS onset so the QRS itself
// is never mistaken for P.
WaveMeasurement measurePWave(const uint16_t* samples, int sampleCount, int rIndex, int qOnsetIdx) {
  WaveMeasurement m = {false, 0.0f, 0.0f};

  int winStart = max(0, rIndex - (int)(0.28f * SAMPLE_RATE));
  int winEnd   = qOnsetIdx - (int)(0.02f * SAMPLE_RATE);
  if (winEnd <= winStart || winStart >= sampleCount) return m;

  float iso = (float)samples[winStart];  // reference: start of this search window (TP segment)
  float peakVal = iso;
  float maxDev = 0.0f;
  int peakIdx = -1;
  for (int i = winStart; i <= winEnd && i < sampleCount; i++) {
    float v = (float)samples[i];
    float dev = v - iso;
    if (fabs(dev) > maxDev) { maxDev = fabs(dev); peakVal = v; peakIdx = i; }
  }
  if (peakIdx < 0) return m;

  m.valid = true;
  m.amplitude = peakVal - iso;  // signed: positive = upright P, negative = inverted P
  m.timeMsFromR = ((float)(peakIdx - rIndex) / (float)SAMPLE_RATE) * 1000.0f;
  return m;
}

// T wave: search the ST segment after this beat's QRS offset for the
// largest deflection (either direction, so an inverted T is measured
// correctly rather than missed). Window runs up to 440ms after R to
// still catch a late T wave at slower heart rates.
WaveMeasurement measureTWave(const uint16_t* samples, int sampleCount, int rIndex, int sOffsetIdx) {
  WaveMeasurement m = {false, 0.0f, 0.0f};

  int winStart = sOffsetIdx + (int)(0.04f * SAMPLE_RATE);
  int winEnd   = min(sampleCount - 1, rIndex + (int)(0.44f * SAMPLE_RATE));
  if (winEnd <= winStart) return m;

  float iso = (float)samples[sOffsetIdx];  // reference: end of QRS (J-point)
  float peakVal = iso;
  float maxDev = 0.0f;
  int peakIdx = -1;
  for (int i = winStart; i <= winEnd; i++) {
    float v = (float)samples[i];
    float dev = v - iso;
    if (fabs(dev) > maxDev) { maxDev = fabs(dev); peakVal = v; peakIdx = i; }
  }
  if (peakIdx < 0) return m;

  m.valid = true;
  m.amplitude = peakVal - iso;  // signed: positive = upright T, negative = inverted T
  m.timeMsFromR = ((float)(peakIdx - rIndex) / (float)SAMPLE_RATE) * 1000.0f;
  return m;
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

  for (int i = 1; i < peakCount; i++) {
    float gapSamples = (float)(peaks[i] - peaks[i - 1]);
    float gapMs = (gapSamples / (float)SAMPLE_RATE) * 1000.0f;
    rrIntervals[rrCount++] = gapMs;
    rrSum += gapSamples;
    rrSqSum += gapSamples * gapSamples;
    if (gapMs > maxGapMs) maxGapMs = gapMs;
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
  float pAmpSum = 0.0f, pTimeSum = 0.0f;
  float tAmpSum = 0.0f, tTimeSum = 0.0f;
  float prIntervalSum = 0.0f, qtIntervalSum = 0.0f;
  int pCount = 0, tCount = 0, prCount = 0, qtCount = 0;

  for (int i = 0; i < peakCount && widthCount < 32; i++) {
    float w = estimateQrsWidth(samples, sampleCount, peaks[i]);
    if (w >= 40.0f && w <= 200.0f) {
      widths[widthCount++] = w;
    }

    int qOnsetIdx, sOffsetIdx;
    findQrsBoundaries(samples, sampleCount, peaks[i], qOnsetIdx, sOffsetIdx);

    WaveMeasurement pWave = measurePWave(samples, sampleCount, peaks[i], qOnsetIdx);
    if (pWave.valid) {
      pAmpSum += pWave.amplitude;
      pTimeSum += pWave.timeMsFromR;
      pCount++;
      // PR interval = P peak time to QRS onset (both relative to R here, so subtract)
      float prMs = ((float)(qOnsetIdx - peaks[i]) / (float)SAMPLE_RATE) * 1000.0f - pWave.timeMsFromR;
      if (prMs > 80.0f && prMs < 320.0f) {  // physiological PR range sanity check
        prIntervalSum += prMs;
        prCount++;
      }
    }

    WaveMeasurement tWave = measureTWave(samples, sampleCount, peaks[i], sOffsetIdx);
    if (tWave.valid) {
      tAmpSum += tWave.amplitude;
      tTimeSum += tWave.timeMsFromR;
      tCount++;
      // QT interval = QRS onset to T peak
      float qtMs = tWave.timeMsFromR - (((float)(qOnsetIdx - peaks[i]) / (float)SAMPLE_RATE) * 1000.0f);
      if (qtMs > 200.0f && qtMs < 600.0f) {  // physiological QT range sanity check
        qtIntervalSum += qtMs;
        qtCount++;
      }
    }
  }

  if (pCount > 0 || tCount > 0) {
    String pStr = pCount > 0
      ? "amp=" + String(pAmpSum / pCount, 0) + "cts t=" + String(pTimeSum / pCount, 0) + "ms"
      : "not detected";
    String tStr = tCount > 0
      ? "amp=" + String(tAmpSum / tCount, 0) + "cts t=" + String(tTimeSum / tCount, 0) + "ms"
      : "not detected";
    String prStr = prCount > 0 ? String(prIntervalSum / prCount, 0) + "ms" : "n/a";
    String qtStr = qtCount > 0 ? String(qtIntervalSum / qtCount, 0) + "ms" : "n/a";
    Serial.println("[PQRST] P: " + pStr + " (" + String(pCount) + "/" + String(peakCount) + " beats) | "
                    + "T: " + tStr + " (" + String(tCount) + "/" + String(peakCount) + " beats) | "
                    + "PR=" + prStr + " QT=" + qtStr);
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
    Serial.println("POST: " + String(code) + " seq=" + String(seq) + " queue=" + String(uxQueueMessagesWaiting(blockQueue)));
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

// v9.4: beepCount lets the caller choose how many beeps this alert makes —
// 1 for a non-critical abnormality (WARNING), 2 for a CRITICAL condition —
// instead of the previous hard-coded single-iteration loop that always
// beeped once no matter what, with severity-based repetition handled
// (incorrectly) by the caller.
void triggerCriticalAlert(int beepCount) {
  for (int i = 0; i < beepCount; i++) {
    buzzerOn(2000);
    digitalWrite(ALERT_LED_PIN, HIGH);
    delay(300);

    buzzerOff();
    digitalWrite(ALERT_LED_PIN, LOW);
    delay(150);  // gap between beeps so repeated beeps are distinguishable
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

      Serial.println("[ECG] seq=" + String(blk.seq) + " deviceId=" + String(blk.deviceId) + " detected=" + condition + " severity=" + severity + " note=" + detail);
      
      // v9.4: severity now maps directly to beep count instead of the
      // earlier inverted logic (which beeped twice for WARNING and only
      // once for CRITICAL). WARNING = non-critical abnormality = 1 beep.
      // CRITICAL = 2 beeps, so the two are clearly distinguishable by ear
      // without having to read the screen/log.
      
      //OLD CODE start comment by Ashok 
      // if (severity == "CRITICAL") {
      //   Serial.println("[ALERT] CRITICAL CONDITION DETECTED! seq=" + String(blk.seq) + " detected=" + condition + " note=" + detail);
      //   digitalWrite(ALERT_LED_PIN, HIGH);
      //   triggerCriticalAlert(2);
      // } else if (severity == "WARNING") {
      //   Serial.println("[WARN] seq=" + String(blk.seq) + " detected=" + condition + " note=" + detail);
      //   digitalWrite(ALERT_LED_PIN, HIGH);
      //   triggerCriticalAlert(1);
      // } else {
      //   buzzerOff();
      //   digitalWrite(ALERT_LED_PIN, LOW);
      // }

      //OLD CODE END  comment by Ashok



//new code start by ashok 
if (severity == "CRITICAL" || severity == "WARNING") {
  unsigned long now = millis();
  bool isNewEpisode = (condition != lastAlertCondition) ||
                       (now - lastAlertMs > ALERT_COOLDOWN_MS);

  Serial.println("[" + severity + "] seq=" + String(blk.seq) + " detected=" + condition + " note=" + detail);
  digitalWrite(ALERT_LED_PIN, HIGH);

  if (isNewEpisode) {
    triggerCriticalAlert(severity == "CRITICAL" ? 2 : 1);
    lastAlertCondition = condition;
    lastAlertMs = now;
  }
  // else: log thay pan beep nahi — same episode already alerted
} else {
  buzzerOff();
  digitalWrite(ALERT_LED_PIN, LOW);
  lastAlertCondition = ""; // reset, taaki next real episode fresh count thaay
}
//new code end by ashok









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
  unsigned long effectiveInterval = (strcmp(userId, deviceId) == 0) ? 3000UL : USER_SYNC_INTERVAL_MS;
  
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
  Serial.println("wifiConnectedAlert called");
  digitalWrite(ALERT_LED_PIN, HIGH);
  buzzerOn(3000);
  delay(1000);
  buzzerOff();
  digitalWrite(ALERT_LED_PIN, LOW);
}

void wifiDisconnectedAlert() {
  digitalWrite(ALERT_LED_PIN, HIGH);
  buzzerOn(1500);
  delay(1000);
  buzzerOff();
  digitalWrite(ALERT_LED_PIN, LOW);
}

void localStatusTask(void* param) {
  unsigned long lastHeartbeat = 0;
  bool wasConnected = false;
  
  for (;;) {
    bool isConnected = (WiFi.status() == WL_CONNECTED);
    
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

  pinMode(ALERT_LED_PIN, OUTPUT);
  digitalWrite(ALERT_LED_PIN, LOW);

  // Buzzer now driven via LEDC PWM (see buzzerOn/buzzerOff) so its
  // loudness is a real, adjustable duty cycle instead of tone()'s fixed
  // full-volume square wave. ledcSetup reserves the channel/frequency/
  // resolution; ledcAttachPin is what actually routes it to BUZZER_PIN —
  // that attach call was missing before, which is why the earlier
  // ledcSetup(0, 2000, 8) line had no effect on the sound.
  ledcSetup(BUZZER_LEDC_CHANNEL, 2000, BUZZER_LEDC_RESOLUTION_BITS);
  ledcAttachPin(BUZZER_PIN, BUZZER_LEDC_CHANNEL);
  buzzerOff();

  loadDeviceId();
  Serial.println("[CFG] Active userId: " + String(userId));
  Serial.println("[CFG] Active deviceId: " + String(deviceId));

  esp_reset_reason_t reason = esp_reset_reason();
  Serial.println("[SYS] Reset reason: " + String(resetReasonToString(reason)));
  
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
    0);
    
  xTaskCreatePinnedToCore(
    localStatusTask,
    "LocalStatusTask",
    4096,
    NULL,
    1,
    NULL,
    0);
    
  // Timer setup
  timer = timerBegin(0, 80, true);
  timerAttachInterrupt(timer, &onTimer, true);
  timerAlarmWrite(timer, SAMPLE_INTERVAL_US, true);
  timerAlarmEnable(timer);

  initSignalFilters();
  
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
    bool loPlus = false;
    bool loMinus = false;

    portENTER_CRITICAL(&timerMux);
    sendBuf = 1 - activeBuffer;
    blockReady = false;
    seqToSend = blockSeq;
    lo = leadsOff;
    loPlus = loPlusOff;
    loMinus = loMinusOff;
    portEXIT_CRITICAL(&timerMux);

    Block blk;
    memcpy(blk.data, buffers[sendBuf], WINDOW_SIZE * sizeof(uint16_t));
    blk.seq = seqToSend;
    blk.lo = lo;
    blk.loPlus = loPlus;
    blk.loMinus = loMinus;

    strncpy(blk.userId, userId, MAX_DEVICE_ID_LEN - 1);
    blk.userId[MAX_DEVICE_ID_LEN - 1] = '\0';
    strncpy(blk.deviceId, deviceId, MAX_DEVICE_ID_LEN - 1);
    blk.deviceId[MAX_DEVICE_ID_LEN - 1] = '\0';
    
    // Apply baseline removal + 50Hz notch + 40Hz low-pass before analysis/sending
    applySignalFiltersToBlock(blk);

    appendAnalysisBlock(blk);
    
    if (xQueueSend(blockQueue, &blk, 0) != pdTRUE) {
      queueOverflows++;
      Serial.println("[Queue] OVERFLOW seq=" + String(seqToSend) + " total=" + String(queueOverflows));
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
