/*
 * ESP32 ECG v10.2 — ADS1292R via ProtoCentral Library
 * ======================================================
 * Same migration as v10.0 (AD8232/analogRead -> ADS1292R 24-bit
 * front-end), but the acquisition layer now goes through the
 * ProtoCentral ADS1292R Breakout Arduino library instead of
 * hand-written SPI register access. Everything else — WiFi/AP mode,
 * REST API + JSON payload shape, send queue/retry, filtering
 * pipeline, PQRST/arrhythmia classification, alerts/buzzer/LEDs,
 * device/user ID handling — is byte-for-byte the same as v10.0.
 *
 * LIBRARY REQUIRED (install via Library Manager or from GitHub):
 *   ProtoCentral ADS1292R Breakout Arduino library
 *   Header used below: protocentralAds1292r.h
 *   Class name in that header: ads1292r (all lowercase — NOT ADS1292R;
 *   v10.1 got this wrong and it's what caused the
 *   "'ADS1292R' does not name a type; did you mean 'ads1292r'?"
 *   compile error. C++ is case-sensitive, and only the lowercase
 *   identifier actually exists in the library, so v10.1's uppercase
 *   ADS1292R type name simply didn't resolve to anything.)
 *
 * !! VERIFY AGAINST YOUR INSTALLED LIBRARY VERSION !!
 *   The library has shipped with slightly different struct field names
 *   across releases/forks (some expose `sDaqVals[2]`, others
 *   `dataCH1`/`dataCH2`; some expose only a combined `leadoffDetected`
 *   bool, others break it out per electrode; the returned struct type
 *   itself may be named `ads1292OutputValues`, `ads1292r_data`, or
 *   similar depending on version). The wrapper functions below
 *   (adsReadEcgSample(), adsPollLeadOff()) plus the two declarations
 *   right after "ADS1292R — ProtoCentral library wrapper" below are the
 *   ONLY places that touch the library's class/struct names — if your
 *   installed version's names differ from what's used here, that's the
 *   only place you need to edit. Open protocentralAds1292r.h after
 *   installing and confirm the class name (`ads1292r`) and the return
 *   struct's name/fields match what's used here before your next
 *   compile — this is exactly the class of error the last build hit.
 *
 * WHY SPI.begin() IS CALLED MANUALLY BEFORE THE LIBRARY INIT:
 *   The ProtoCentral library was written for AVR boards (Uno/Mega)
 *   where SPI pins are fixed in hardware, so its ads1292Init() doesn't
 *   take SCLK/MOSI/MISO arguments — it just uses whatever the default
 *   SPI object is already bound to. On ESP32 the SPI pins are software-
 *   assignable, so this firmware calls SPI.begin(sck, miso, mosi, cs)
 *   itself first to route the default SPI bus onto ADS_SCLK_PIN /
 *   ADS_MISO_PIN / ADS_MOSI_PIN / ADS_CS_PIN; every SPI.transfer() the
 *   library does afterward rides on that same remapped bus.
 *
 * HARDWARE WIRING (unchanged from v10.0):
 *   ADS1292R DIN   -> ESP32 GPIO23 (MOSI)
 *   ADS1292R DOUT  -> ESP32 GPIO19 (MISO)
 *   ADS1292R SCLK  -> ESP32 GPIO18 (SCLK)
 *   ADS1292R CS    -> ESP32 GPIO5
 *   ADS1292R DRDY  -> ESP32 GPIO4  (input, active low, falling-edge IRQ)
 *   ADS1292R START -> ESP32 GPIO15
 *   ADS1292R PWDN/RESET -> tie high, or wire to ADS_RESET_PIN if your
 *                     breakout exposes it separately (the ProtoCentral
 *                     library does not drive a reset pin itself, so if
 *                     your board needs one, toggle it once in adsInit()
 *                     before calling ads1292Init(), as shown below).
 *   NOTE: GPIO18/GPIO5 were the old AD8232 LO+/LO- pins pre-migration —
 *   they are now SPI SCLK/CS and no longer usable as plain digital
 *   inputs. Expected and intentional.
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
#include <freertos/semphr.h>
#include <SPI.h>
#include <protocentralAds1292r.h>   // ProtoCentral ADS1292R Breakout library
// v10.2 FIX: this specific ProtoCentral library (header
// protocentralAds1292r.h) names its class "ads1292r" (all lowercase),
// NOT "ADS1292R" — that's exactly what the compiler error meant by
// "'ADS1292R' does not name a type; did you mean 'ads1292r'?" C++ is
// case-sensitive, so "ADS1292R" and "ads1292r" are two different
// identifiers, and only the lowercase one actually exists in this
// library. Fixed below (the object is still called ads1292r_dev,
// which is fine — that's just our own variable name).

// -------------------- CONFIG --------------------
#define API_URL "https://ads1292r-code.onrender.com/api/ecg"
#define WIFI_CFG_DEVICE_URL "https://ads1292r-code.onrender.com/api/wifi-config/device/"
#define DEFAULT_DEVICE_ID "ESP_ECG_123"
#define DEFAULT_USER_ID ""
#define MAX_DEVICE_ID_LEN 32
#define SETUP_AP_SSID "ECG_Setup"
#define SETUP_AP_PASS "12345678"

// ---------------- ADS1292R SPI pins ----------------
#define ADS_MOSI_PIN  23
#define ADS_MISO_PIN  19
#define ADS_SCLK_PIN  18
#define ADS_CS_PIN    5
#define ADS_DRDY_PIN  15
#define ADS_START_PIN 4
#define ADS_RESET_PIN 16   // optional — only used if your breakout exposes RESET/PWDN separately

#define LED_PIN 2

// v10.x: 125 SPS is the ProtoCentral library's actual default output rate
// (it programs DR=001 = 125 SPS in CONFIG1 during ads1292Init). The
// ADS1292R's DR register only takes values from a fixed set (125/250/500/
// 1000/2000/4000/8000 SPS) and the library does not take an SPS argument,
// so verify against protocentralAds1292r.cpp before changing this.
// Every timing-derived constant downstream is computed FROM SAMPLE_RATE.
#define SAMPLE_RATE 125
#define WINDOW_SIZE SAMPLE_RATE                 // 1 second of data per Block, same cadence as before
#define ANALYSIS_WINDOW_SIZE (SAMPLE_RATE * 5)   // 5-second rolling classification window, same as before
#define QUEUE_DEPTH 10

#define BUZZER_PIN 33
#define ALERT_LED_PIN 26
#define POWER_SENSE_PIN 34
#define BUTTON_PIN 27

// --------- Buzzer volume control (unchanged from v9.3) ---------
#define BUZZER_LEDC_CHANNEL 0
#define BUZZER_LEDC_RESOLUTION_BITS 8
#define BUZZER_VOLUME_DUTY 30

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
  int32_t data[WINDOW_SIZE];   // signed 24-bit-in-32-bit ADS1292R codes
  uint32_t seq;
  bool lo;
  bool loPlus;   // RA (IN1P) electrode off
  bool loMinus;  // LA (IN1N) electrode off
  char userId[MAX_DEVICE_ID_LEN];
  char deviceId[MAX_DEVICE_ID_LEN];
};

struct WaveMeasurement {
  bool valid;
  float amplitude;    // ADS1292R codes, signed, relative to the local isoelectric (TP/ST) reference
  float timeMsFromR;  // negative = before R (P), positive = after R (T)
};

int32_t buffers[2][WINDOW_SIZE];
int32_t analysisWindow[ANALYSIS_WINDOW_SIZE];
int32_t analysisSnapshot[ANALYSIS_WINDOW_SIZE];
float analysisCentered[ANALYSIS_WINDOW_SIZE];

volatile int activeBuffer = 0;
volatile int sampleIndex = 0;
volatile bool blockReady = false;
volatile bool leadsOff = false;
volatile bool loPlusOff = false;
volatile bool loMinusOff = false;
volatile uint32_t blockSeq = 0;
volatile uint32_t analysisWriteIndex = 0;
volatile uint32_t analysisSampleCount = 0;
volatile uint32_t analysisLatestSeq = 0;

// Declared here (not further down with the other globals) because the
// ADS1292R wrapper functions right below need it, and Arduino only
// auto-forward-declares functions, not global variables.
portMUX_TYPE timerMux = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE analysisMux = portMUX_INITIALIZER_UNLOCKED;

// ============================================================
// ADS1292R — ProtoCentral library wrapper
// ============================================================
// ads1292r_dev is the library object; ads1292Data is the struct its
// ads1292GetData() call fills in per read. Everything outside this
// section talks to the two small wrapper functions below
// (adsReadEcgSample / adsPollLeadOff / adsInit / adsWake /
// adsEnterStandby) — no other code in the file touches the library
// directly, so a library-version field-name mismatch only needs a fix
// in one place.
// v10.2: class is "ads1292r" (lowercase) in protocentralAds1292r.h, not
// "ADS1292R". If your installed copy of the library also names the
// return-struct type something other than "ads1292OutputValues" (some
// forks call it ads1292r_data / ads1292_data), the compiler will point
// at this exact line next — open protocentralAds1292r.h, find the
// struct typedef near the class declaration, and swap the type name in
// both places below (here and in adsReadEcgSample()).
ads1292r ads1292r_dev;
ads1292OutputValues ads1292Data;

// Full-scale signed 24-bit code range (same physical meaning as v10.0)
#define ADS_FULLSCALE_CODE 8388607.0f   // 2^23 - 1

// PGA gain/reference the library's default ads1292Init() programs on
// CH1 (gain=6, VREF=2.42V is the ADS1292R power-on-reset/library
// default). Used only to convert magic-number thresholds into physical
// microvolts below — not sent to the chip directly. If you call any
// lower-level library setter to change gain, update this to match.
#define ADS_PGA_GAIN      6.0f
#define ADS_VREF_VOLTS    2.42f
#define ADS_UV_PER_CODE   ((ADS_VREF_VOLTS / ADS_PGA_GAIN) / ADS_FULLSCALE_CODE * 1.0e6f)

static inline int32_t uvToCode(float microvolts) {
  return (int32_t)(microvolts / ADS_UV_PER_CODE);
}

SemaphoreHandle_t drdySemaphore = NULL;

void IRAM_ATTR onDrdyFalling() {
  BaseType_t xHigherPriorityTaskWoken = pdFALSE;
  xSemaphoreGiveFromISR(drdySemaphore, &xHigherPriorityTaskWoken);
  if (xHigherPriorityTaskWoken) portYIELD_FROM_ISR();
}

// --------- LEAD-OFF DETECTION ---------
// The ProtoCentral library's ads1292OutputValues struct exposes lead-
// off as a single combined `leadoffDetected` bool in most published
// versions (it doesn't break out IN1P vs IN1N separately the way raw
// LOFF_STAT register bits do). That means loPlus/loMinus can't be told
// apart through this library without dropping down to a manual RREG on
// LOFF_STAT (0x08) yourself — which defeats the point of switching to
// the library. Practical compromise kept here: both loPlusOff and
// loMinusOff are set to the same combined flag, and the Serial/backend
// log says "lead off (RA/LA undetermined)" instead of naming a specific
// electrode. If your library fork DOES expose separate per-electrode
// bits (check ads1292r.h for something like `.loffStatусрег` /
// `.ch1LeadOffP` / `.ch1LeadOffN`), swap them in here.
#define LOFF_POLL_INTERVAL_SAMPLES 63   // ~0.5s at 125 SPS — lead-off is a mechanical/contact event, doesn't need sub-second latency
static uint32_t samplesSinceLoffPoll = 0;
static unsigned long lastLoffDebugPrintMs = 0;

static void adsPollLeadOff(bool combinedLeadOff) {
  portENTER_CRITICAL(&timerMux);
  loPlusOff = combinedLeadOff;
  loMinusOff = combinedLeadOff;
  leadsOff = combinedLeadOff;
  portEXIT_CRITICAL(&timerMux);

  unsigned long nowMs = millis();
  if (nowMs - lastLoffDebugPrintMs > 1000) {
    lastLoffDebugPrintMs = nowMs;
    Serial.println("[LOFF] library leadoffDetected=" + String(combinedLeadOff ? "true" : "false"));
  }
}

void adsInit() {
  pinMode(ADS_START_PIN, OUTPUT);
  pinMode(ADS_DRDY_PIN, INPUT);

#ifdef ADS_RESET_PIN
  // Only needed if your breakout wires RESET/PWDN to its own pin; the
  // ProtoCentral library doesn't drive one itself. Harmless no-op if
  // your board ties RESET high in hardware instead.
  pinMode(ADS_RESET_PIN, OUTPUT);
  digitalWrite(ADS_RESET_PIN, HIGH);
  delay(10);
  digitalWrite(ADS_RESET_PIN, LOW);
  delay(2);
  digitalWrite(ADS_RESET_PIN, HIGH);
  delay(10);
#endif

  // Route the ESP32's default SPI bus onto the ADS1292R pins BEFORE the
  // library touches SPI — see header note. Order matters: this must
  // run before ads1292Init().
  SPI.begin(ADS_SCLK_PIN, ADS_MISO_PIN, ADS_MOSI_PIN, ADS_CS_PIN);

  // Library init: internally does SDATAC, writes CONFIG1/CONFIG2/LOFF/
  // CH1SET/CH2SET/RLD_SENS/LOFF_SENS to its built-in defaults (500SPS,
  // gain=6, single/dual-lead per library version), then issues START +
  // RDATAC. See the library's own ads1292r.cpp if you need to change
  // any of those defaults (e.g. to enable CH2, or change gain — update
  // ADS_PGA_GAIN above to match if you do).
  ads1292r_dev.ads1292Init(ADS_CS_PIN, ADS_RESET_PIN, ADS_START_PIN);

  Serial.println("[ADS1292R] ProtoCentral library init complete: target " + String(SAMPLE_RATE) + " SPS (verify against library's actual DR default in protocentralAds1292r.cpp)");
}

void adsEnterStandby() {
  // The ProtoCentral library doesn't expose a wrapped STANDBY command
  // call, so this is a simplified power gate: pulling START low stops
  // the chip from producing new conversions/DRDY edges without a full
  // SPI STANDBY sequence. Good enough for "system off" here since the
  // acquisition task is also paused (see setSystemPowerState()); for a
  // true micro-power standby, add the library's low-level command
  // function if your version exposes one.
  digitalWrite(ADS_START_PIN, LOW);
}

void adsWake() {
  digitalWrite(ADS_START_PIN, HIGH);
}

// Called from acquisitionTask() once per DRDY edge. This is the ONLY
// place that reads ads1292Data's fields — if your installed library
// version names them differently, fix it here only.
static int32_t adsReadEcgSample(bool& leadOffOut) {
  // The public API polls DRDY and reads 9 SPI bytes in one call.
  // We already know DRDY fired (semaphore), so digitalRead(ADS_DRDY_PIN)
  // will return LOW = ready. Pass the pin numbers and a pointer to the
  // output struct.
  boolean ok = ads1292r_dev.getAds1292EcgAndRespirationSamples(
      ADS_DRDY_PIN, ADS_CS_PIN, &ads1292Data);

  // sDaqVals[0] / sDaqVals[1] are the two ADS1292R channels as the
  // ProtoCentral library returns them (commonly CH1=ECG, CH2=respiration
  // or CH2 on this single-lead build). If your board/library maps ECG
  // to the other index, swap which one is read here.
  int32_t ecgSample = ok ? (int32_t)ads1292Data.sDaqVals[1] : 0;
  leadOffOut = ads1292Data.leadoffDetected;
  return ecgSample;
}

// ============================================================
// THRESHOLDS IN PHYSICAL UNITS
// ============================================================
#define CLIP_FRACTION_OF_FULLSCALE 0.95f
static const int32_t CLIP_HIGH_CODE = (int32_t)(ADS_FULLSCALE_CODE * CLIP_FRACTION_OF_FULLSCALE);
static const int32_t CLIP_LOW_CODE  = -CLIP_HIGH_CODE;
static const int32_t LOW_AMPLITUDE_CODE = uvToCode(20.0f);   // lowered: ~10µV floor, any real ECG exceeds this
static const int32_t SPIKE_DELTA_CODE = uvToCode(2000.0f);
static const float BL_MAX_STEP_PER_CAND = (float)uvToCode(150.0f);
static const float BL_CONTAM_PTP_THRESHOLD = (float)uvToCode(600.0f);

// --------- 0.5Hz Linear High-Pass filter state (unused directly —
// baseline removal below is median-based; kept for structural parity)
static float hp_s1 = 0.0f;
static float hp_s2 = 0.0f;
static float hp_b0 = 1.0f, hp_b1 = 0.0f, hp_b2 = 0.0f;
static float hp_a1 = 0.0f, hp_a2 = 0.0f;
static bool hp_initialized = false;

// --------- 50Hz Notch filter state (unchanged design)
static float notch_s1 = 0.0f;
static float notch_s2 = 0.0f;
static float notch_b0 = 1.0f, notch_b1 = 0.0f, notch_b2 = 0.0f;
static float notch_a1 = 0.0f, notch_a2 = 0.0f;
static bool notch_initialized = false;

// --------- 40Hz Low-pass: zero-phase FIR moving-average (double pass) ---------
static const int LP_MOVING_AVG_WIN = max(3, (int)lroundf(3.0f * ((float)SAMPLE_RATE / 360.0f)));

// --------- Median (spike) filter state
static int32_t median_prev1 = 0;

// --------- Baseline wander removal (two-stage median) state ---------
static const int BL_STAGE1_WIN = max(8, (int)lroundf(0.200f * SAMPLE_RATE));   // ~200ms
static const int BL_CANDS_PER_BLOCK = WINDOW_SIZE / BL_STAGE1_WIN;
#define BL_STAGE2_WIN 5
#define BL_HISTORY_LEN 16

static float blStage1History[BL_HISTORY_LEN];
static int   blHistoryCount = 0;
static int   blHistoryHead  = 0;
static float blLastAnchor   = 0.0f;
static bool  blInitialized  = false;

static String lastAlertCondition = "";
static unsigned long lastAlertMs = 0;
const unsigned long ALERT_COOLDOWN_MS = 8000;

static float workBuf[WINDOW_SIZE];

QueueHandle_t blockQueue = NULL;
uint32_t queueOverflows = 0;

unsigned long lastUserSyncMs = 0;
const unsigned long USER_SYNC_INTERVAL_MS = 15000;
String reconnectSsid = "";
String reconnectPass = "";
bool hasReconnectCreds = false;
unsigned long lastReconnectAttemptMs = 0;
const unsigned long RECONNECT_INTERVAL_MS = 5000;
uint8_t reconnectFailStreak = 0;
const uint8_t RECONNECT_FAIL_LIMIT = 3;
bool reconnectEnabled = true;
bool setupApMode = false;
bool systemOn = true;
bool lastButtonState = HIGH;
unsigned long lastButtonDebounceMs = 0;
unsigned long buttonPressStartMs = 0;
bool longPressHandled = false;
const unsigned long BUTTON_HOLD_MS = 1000;

// ============================================================
// BUZZER (unchanged)
// ============================================================
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

    digitalWrite(LED_PIN, LOW);
    Serial.println("[WiFi] turnWifiOn: connecting to saved network: " + reconnectSsid);
    WiFi.begin(reconnectSsid.c_str(), reconnectPass.c_str());

    int retry = 0;
    while (WiFi.status() != WL_CONNECTED && retry < 20) {
      delay(500);
      Serial.print(".");
      retry++;
    }

    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("\n[WiFi] turnWifiOn: connected");
      Serial.println(WiFi.localIP());
      digitalWrite(LED_PIN, HIGH);
      reconnectFailStreak = 0;
      return;
    }

    Serial.println("\n[WiFi] turnWifiOn: saved network unavailable, switching to AP mode");
    reconnectEnabled = true;
    setupApMode = true;
    startAP();
  } else {
    reconnectEnabled = false;
    setupApMode = true;
    startAP();
  }
}

void setSystemPowerState(bool on) {
  systemOn = on;

  if (systemOn) {
    adsWake();
    Serial.println("[SYS] ECG SYSTEM ON");
    digitalWrite(ALERT_LED_PIN, HIGH);
    delay(120);
    digitalWrite(ALERT_LED_PIN, LOW);
    previousWifiState = false;
    turnWifiOn();
    beepTone(2500, 120);
  } else {
    adsEnterStandby();
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
// ACQUISITION TASK (DRDY-driven, replaces the old timer ISR)
// ============================================================
void acquisitionTask(void* param) {
  for (;;) {
    if (xSemaphoreTake(drdySemaphore, portMAX_DELAY) != pdTRUE) continue;

    samplesSinceLoffPoll++;
    bool doLoffPoll = (samplesSinceLoffPoll >= LOFF_POLL_INTERVAL_SAMPLES);
    if (doLoffPoll) samplesSinceLoffPoll = 0;

    // Always read the chip on every DRDY edge — the lead-off flag comes
    // embedded in the status bytes of the same SPI frame, so reading when
    // leadsOff is stale-true is fine: we get a fresh sample AND a fresh
    // leadOffThisSample in one call, then decide what to store below.
    bool leadOffThisSample = false;
    int32_t sample = adsReadEcgSample(leadOffThisSample);

    // Replace samples with 0 when leads are off so the backend / Python
    // can identify dead blocks, but still store the lead-off state.
    if (leadOffThisSample) sample = 0;

    portENTER_CRITICAL(&timerMux);
    buffers[activeBuffer][sampleIndex] = sample;
    sampleIndex++;

    if (sampleIndex >= WINDOW_SIZE) {
      sampleIndex = 0;
      activeBuffer = 1 - activeBuffer;
      blockSeq++;
      blockReady = true;
    }
    portEXIT_CRITICAL(&timerMux);

    if (doLoffPoll) adsPollLeadOff(leadOffThisSample);
  }
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

  reconnectSsid = ssid;
  reconnectPass = password;
  hasReconnectCreds = true;
  reconnectEnabled = true;

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
    reconnectFailStreak = 0;
    setupApMode = false;
    return true;
  }

  Serial.println("\n[WiFi] Saved network failed, will use AP mode");
  return false;
}

void attemptReconnectIfNeeded() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (!reconnectEnabled) return;

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
  if (setupApMode) WiFi.mode(WIFI_AP_STA);
  else WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, false);
  delay(50);
  WiFi.begin(reconnectSsid.c_str(), reconnectPass.c_str());

  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 8) {
    delay(250);
    retry++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    reconnectFailStreak = 0;
    if (setupApMode) {
      WiFi.softAPdisconnect(true);
      setupApMode = false;
      Serial.println("[WiFi] Saved network restored, AP stopped");
    }
    digitalWrite(LED_PIN, HIGH);
    Serial.println("[WiFi] Reconnect success");
    return;
  }

  if (reconnectFailStreak < 255) reconnectFailStreak++;
  Serial.println("[WiFi] Reconnect failed (" + String(reconnectFailStreak) + "/" + String(RECONNECT_FAIL_LIMIT) + ")");

  if (reconnectFailStreak >= RECONNECT_FAIL_LIMIT) {
    if (!setupApMode) {
      Serial.println("[WiFi] Saved network not available -> entering AP mode (ECG_Setup)");
      reconnectEnabled = true;
      setupApMode = true;
      startAP();
    }
    reconnectFailStreak = RECONNECT_FAIL_LIMIT;
  }
}

// ============================================================
// START AP MODE
// ============================================================
void startAP() {
  WiFi.disconnect(true, false);
  WiFi.softAPdisconnect(true);
  delay(50);

  WiFi.mode(WIFI_AP);
  bool apOk = WiFi.softAP(SETUP_AP_SSID, SETUP_AP_PASS);

  if (!apOk) {
    WiFi.mode(WIFI_OFF);
    delay(120);
    WiFi.mode(WIFI_AP);
    apOk = WiFi.softAP(SETUP_AP_SSID, SETUP_AP_PASS);
  }

  if (apOk) {
    Serial.println("[WiFi] AP Started: " + String(SETUP_AP_SSID));
    Serial.println("[WiFi] AP Password: " + String(SETUP_AP_PASS));
    Serial.println(WiFi.softAPIP());
  } else {
    Serial.println("[WiFi] AP start failed");
  }
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
    reconnectFailStreak = 0;
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
  median_prev1 = 0;
  blHistoryCount = 0;
  blHistoryHead  = 0;
  blLastAnchor   = 0.0f;
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
  initNotch50Hz((float)SAMPLE_RATE);
  median_prev1 = 0;
  Serial.println("[FILTER] Median baseline removal + Notch 50Hz (Q=2) + zero-phase FIR LP enabled (fs=" + String(SAMPLE_RATE) + "Hz, LP taps=" + String(LP_MOVING_AVG_WIN) + ")");
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

static float medianOfFloats(float* tmp, int n) {
  for (int i = 1; i < n; i++) {
    float key = tmp[i]; int j = i - 1;
    while (j >= 0 && tmp[j] > key) { tmp[j + 1] = tmp[j]; j--; }
    tmp[j + 1] = key;
  }
  return (n % 2 == 1) ? tmp[n / 2] : 0.5f * (tmp[n / 2 - 1] + tmp[n / 2]);
}

void removeBaselineWander(float* data, int len) {
  float tmp1[BL_STAGE1_WIN];
  float tmp2[BL_STAGE2_WIN];

  for (int c = 0; c < BL_CANDS_PER_BLOCK; c++) {
    int lo = c * BL_STAGE1_WIN;
    int hi = min(len, lo + BL_STAGE1_WIN);
    if (hi <= lo) break;
    int n1 = hi - lo;

    for (int i = 0; i < n1; i++) tmp1[i] = data[lo + i];

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
      anchor = blLastAnchor;
    }

    if (!blInitialized) {
      blLastAnchor = anchor;
      blInitialized = true;
    } else {
      float delta = anchor - blLastAnchor;
      if (delta > BL_MAX_STEP_PER_CAND) anchor = blLastAnchor + BL_MAX_STEP_PER_CAND;
      else if (delta < -BL_MAX_STEP_PER_CAND) anchor = blLastAnchor - BL_MAX_STEP_PER_CAND;
    }

    for (int i = 0; i < n1; i++) {
      float frac = (float)(i + 1) / (float)n1;
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

void applyLowPassToBlock(float* data, int len) {
  float temp[WINDOW_SIZE];
  movingAveragePass(data, temp, len);
  movingAveragePass(temp, data, len);
}

void applyMedianToBlock(int32_t* data, int len) {
  int32_t prev = median_prev1;
  for (int i = 0; i < len; i++) {
    int32_t cur  = data[i];
    int32_t next = (i < len - 1) ? data[i + 1] : cur;
    int32_t a = prev, b = cur, c = next;

    if (a > b) { int32_t t = a; a = b; b = t; }
    if (b > c) { int32_t t = b; b = c; c = t; }
    if (a > b) { int32_t t = a; a = b; b = t; }

    prev = data[i];
    data[i] = b;
  }
  median_prev1 = prev;
}

void applySignalFiltersToBlock(Block& blk) {
  if (blk.lo) {
    resetSignalFilterState();
    String leadMsg;
    if (blk.loPlus && blk.loMinus) leadMsg = "RA/LA (combined, library reports single leadoff flag)";
    else if (blk.loPlus) leadMsg = "RA (IN1P)";
    else if (blk.loMinus) leadMsg = "LA (IN1N)";
    else leadMsg = "unknown";
    Serial.println("[FILTER] Leads off -> filter state reset (" + leadMsg + " disconnected)");
    return;
  }

  applyMedianToBlock(blk.data, WINDOW_SIZE);

  for (int i = 0; i < WINDOW_SIZE; i++) workBuf[i] = (float)blk.data[i];

  removeBaselineWander(workBuf, WINDOW_SIZE);
  applyNotchToBlock(workBuf, WINDOW_SIZE);
  applyLowPassToBlock(workBuf, WINDOW_SIZE);

  for (int i = 0; i < WINDOW_SIZE; i++) {
    float y = workBuf[i];
    if (y < -ADS_FULLSCALE_CODE) y = -ADS_FULLSCALE_CODE;
    if (y > ADS_FULLSCALE_CODE) y = ADS_FULLSCALE_CODE;
    blk.data[i] = (int32_t)y;
  }
}

bool copyAnalysisWindow(int32_t* outSamples, uint32_t& sampleCount, uint32_t& latestSeq) {
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
    return "ptp=" + ptp + " codes (threshold " + String(LOW_AMPLITUDE_CODE) + ")";
  }
  if (reason.startsWith("NOISY_SIGNAL=")) {
    String ratio = reason.substring(String("NOISY_SIGNAL=").length());
    return "noise ratio=" + ratio + " (threshold 12.5%)";
  }
  return "Check electrodes";
}

bool validateSamples(const int32_t* samples, int sampleCount, String& reason) {
  reason = "";

  int32_t minV = INT32_MAX;
  int32_t maxV = INT32_MIN;
  uint32_t zeroCount = 0;
  uint32_t clipCount = 0;
  uint32_t spikeCount = 0;

  for (int i = 0; i < sampleCount; i++) {
    int32_t value = samples[i];
    if (value == 0) zeroCount++;
    if (value <= CLIP_LOW_CODE || value >= CLIP_HIGH_CODE) clipCount++;
    if (value < minV) minV = value;
    if (value > maxV) maxV = value;
    if (i > 0) {
      int32_t delta = abs(value - samples[i - 1]);
      if (delta > SPIKE_DELTA_CODE) spikeCount++;
    }
  }

  float zeroRatio = (float)zeroCount / (float)sampleCount;
  float clipRatio = (float)clipCount / (float)sampleCount;
  int32_t ptp = maxV - minV;

  if (zeroRatio > 0.15f) {
    reason = "TOO_MANY_ZERO_SAMPLES=" + String(zeroRatio, 2);
  } else if (clipRatio > 0.02f) {
    reason = "CLIPPED_SIGNAL=" + String(clipRatio, 2);
  } else if (ptp < LOW_AMPLITUDE_CODE) {
    reason = "LOW_AMPLITUDE=" + String(ptp);
  } else if (spikeCount > (sampleCount / 8)) {
    float spikeRatio = (float)spikeCount / (float)sampleCount;
    reason = "NOISY_SIGNAL=" + String(spikeRatio, 2);
  }

  return reason.length() > 0;
}

int detectPeaks(const int32_t* samples, int sampleCount, int* peaks, int maxPeaks, float& maxAbs) {
  long long sum = 0;
  for (int i = 0; i < sampleCount; i++) {
    sum += samples[i];
  }

  float mean = (float)((double)sum / (double)sampleCount);
  maxAbs = 0.0f;
  for (int i = 0; i < sampleCount; i++) {
    analysisCentered[i] = (float)samples[i] - mean;
    float absVal = fabs(analysisCentered[i]);
    if (absVal > maxAbs) maxAbs = absVal;
  }

  static const float PEAK_FLOOR_CODE = (float)uvToCode(20.0f);
  if (maxAbs < PEAK_FLOOR_CODE) return 0;
  float threshold = maxAbs * 0.50f;
  int peakCount = 0;
  int minDistance = SAMPLE_RATE / 4;
  int lastPeak = -minDistance;

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

float estimateQrsWidth(const int32_t* samples, int sampleCount, int rIndex) {
  int searchRadius = (int)(0.07f * SAMPLE_RATE);
  int start = max(0, rIndex - searchRadius);
  int end = min(sampleCount - 1, rIndex + searchRadius);
  if (end <= start) return 90.0f;

  float localMax = -1e12f;
  float localMin = 1e12f;
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

  float widthSamples = (float)max(1, right - left);
  return (widthSamples / (float)SAMPLE_RATE) * 1000.0f;
}

void findQrsBoundaries(const int32_t* samples, int sampleCount, int rIndex, int& qOnsetIdx, int& sOffsetIdx) {
  int searchRadius = (int)(0.07f * SAMPLE_RATE);
  int start = max(0, rIndex - searchRadius);
  int end = min(sampleCount - 1, rIndex + searchRadius);
  qOnsetIdx = start;
  sOffsetIdx = end;
  if (end <= start) return;

  float localMax = -1e12f, localMin = 1e12f;
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

WaveMeasurement measurePWave(const int32_t* samples, int sampleCount, int rIndex, int qOnsetIdx) {
  WaveMeasurement m = {false, 0.0f, 0.0f};

  int winStart = max(0, rIndex - (int)(0.28f * SAMPLE_RATE));
  int winEnd   = qOnsetIdx - (int)(0.02f * SAMPLE_RATE);
  if (winEnd <= winStart || winStart >= sampleCount) return m;

  float iso = (float)samples[winStart];
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
  m.amplitude = peakVal - iso;
  m.timeMsFromR = ((float)(peakIdx - rIndex) / (float)SAMPLE_RATE) * 1000.0f;
  return m;
}

WaveMeasurement measureTWave(const int32_t* samples, int sampleCount, int rIndex, int sOffsetIdx) {
  WaveMeasurement m = {false, 0.0f, 0.0f};

  int winStart = sOffsetIdx + (int)(0.04f * SAMPLE_RATE);
  int winEnd   = min(sampleCount - 1, rIndex + (int)(0.44f * SAMPLE_RATE));
  if (winEnd <= winStart) return m;

  float iso = (float)samples[sOffsetIdx];
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
  m.amplitude = peakVal - iso;
  m.timeMsFromR = ((float)(peakIdx - rIndex) / (float)SAMPLE_RATE) * 1000.0f;
  return m;
}

String classifyWindow(const int32_t* samples, int sampleCount, String& severity, String& detail) {
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
      float prMs = ((float)(qOnsetIdx - peaks[i]) / (float)SAMPLE_RATE) * 1000.0f - pWave.timeMsFromR;
      if (prMs > 80.0f && prMs < 320.0f) {
        prIntervalSum += prMs;
        prCount++;
      }
    }

    WaveMeasurement tWave = measureTWave(samples, sampleCount, peaks[i], sOffsetIdx);
    if (tWave.valid) {
      tAmpSum += tWave.amplitude;
      tTimeSum += tWave.timeMsFromR;
      tCount++;
      float qtMs = tWave.timeMsFromR - (((float)(qOnsetIdx - peaks[i]) / (float)SAMPLE_RATE) * 1000.0f);
      if (qtMs > 200.0f && qtMs < 600.0f) {
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

  double meanSample = 0.0;
  for (int i = 0; i < sampleCount; i++) meanSample += (double)samples[i];
  meanSample /= (double)sampleCount;

  float ampSum = 0.0f;
  float ampSqSum = 0.0f;
  int ampCount = 0;
  for (int i = 0; i < peakCount; i++) {
    int idx = peaks[i];
    if (idx >= 0 && idx < sampleCount) {
      float amp = fabs((float)((double)samples[idx] - meanSample));
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

void triggerCriticalAlert(int beepCount) {
  for (int i = 0; i < beepCount; i++) {
    buzzerOn(2000);
    digitalWrite(ALERT_LED_PIN, HIGH);
    delay(300);

    buzzerOff();
    digitalWrite(ALERT_LED_PIN, LOW);
    delay(150);
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
      } else {
        buzzerOff();
        digitalWrite(ALERT_LED_PIN, LOW);
        lastAlertCondition = "";
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

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  pinMode(ALERT_LED_PIN, OUTPUT);
  digitalWrite(ALERT_LED_PIN, LOW);

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
    reconnectEnabled = hasReconnectCreds;
    setupApMode = true;
    startAP();
  }
  startServer();

  client.setInsecure();
  http.setReuse(true);

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

  // ADS1292R bring-up (ProtoCentral library) + DRDY-driven acquisition
  drdySemaphore = xSemaphoreCreateBinary();
  adsInit();

  xTaskCreatePinnedToCore(
    acquisitionTask,
    "AcqTask",
    4096,
    NULL,
    2,          // higher priority than send/local tasks: hard 2ms (500SPS) budget
    NULL,
    1);         // core 1, away from WiFi's core-0 tasks

  attachInterrupt(digitalPinToInterrupt(ADS_DRDY_PIN), onDrdyFalling, FALLING);

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
    memcpy(blk.data, buffers[sendBuf], WINDOW_SIZE * sizeof(int32_t));
    blk.seq = seqToSend;
    blk.lo = lo;
    blk.loPlus = loPlus;
    blk.loMinus = loMinus;

    strncpy(blk.userId, userId, MAX_DEVICE_ID_LEN - 1);
    blk.userId[MAX_DEVICE_ID_LEN - 1] = '\0';
    strncpy(blk.deviceId, deviceId, MAX_DEVICE_ID_LEN - 1);
    blk.deviceId[MAX_DEVICE_ID_LEN - 1] = '\0';

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
