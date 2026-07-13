/**
 * main.cpp
 * -----------------------------------------------------------
 * SWET_IOT - ECG v11.0 (PlatformIO)
 * ESP32 NodeMCU-32S + ProtoCentral ADS1292R Breakout v3.1
 *
 * Output: full raw signed 24-bit ADC values (int32_t).
 * No scaling to [0,4095]. Serial Plotter auto-scales.
 * ADS1292R @ gain=6, VREF=2.42V → ±8,388,607 full scale.
 * Typical ECG QRS peak ≈ ±20,000–40,000 counts.
 *
 * WiFi: concurrent AP+STA mode.
 *  - AP always on (SSID: ECG_ADS1292R) so a stranger can always
 *    connect and configure WiFi at 192.168.4.1.
 *  - STA auto-reconnects every 5s when disconnected.
 *  - If STA is down for >15s the AP is guaranteed active.
 *
 * Database: POSTs 125-sample blocks to ads1292r-code.onrender.com
 *  via a FreeRTOS queue on Core 0 so the 125-SPS loop is never
 *  blocked by network latency.
 *
 * Buzzer: REMOVED (not connected in current circuit).
 * -----------------------------------------------------------
 */

#include <Arduino.h>
#include <WiFi.h>
#include "config.h"
#include "pin_config.h"
#include "types.h"
#include "drivers/ads1292r.h"
#include "drivers/ecg_pipeline.h"
#include "network.h"

// ==========================================================
// Objects
// ==========================================================
static ADS1292R    ads;
static ECGPipeline pipeline;

// ==========================================================
// Ping-Pong Buffer  (int32_t — full raw ADC range)
// ==========================================================
static int32_t           g_buffers[2][WINDOW_SIZE];
static volatile int      g_activeBuffer = 0;
static volatile int      g_sampleIndex  = 0;
static volatile bool     g_blockReady   = false;
static volatile uint32_t g_blockSeq     = 0;
static volatile bool     g_leadsOff     = false;
static volatile bool     g_loPlusOff    = false;
static volatile bool     g_loMinusOff   = false;
static portMUX_TYPE      g_bufMux       = portMUX_INITIALIZER_UNLOCKED;

// ==========================================================
// Counters
// ==========================================================
static uint32_t g_totalSamples   = 0;
static uint32_t g_validBlocks    = 0;
static uint32_t g_invalidBlocks  = 0;
static uint32_t g_leadOffEvents  = 0;
static uint32_t g_lastRateCheck  = 0;
static uint32_t g_rateCheckCount = 0;
const  uint32_t RATE_CHECK_MS    = 5000;

// ==========================================================
// Register snapshot printer
// ==========================================================
static void printRegisterSnapshot(const ADS1292_RegisterSnapshot& snap) {
    Serial.println(F("#---- ADS1292R Register Dump ----"));
    Serial.print(F("#ID        : 0x")); Serial.println(snap.id,        HEX);
    Serial.print(F("#CONFIG1   : 0x")); Serial.println(snap.config1,   HEX);
    Serial.print(F("#CONFIG2   : 0x")); Serial.println(snap.config2,   HEX);
    Serial.print(F("#LOFF      : 0x")); Serial.println(snap.loff,      HEX);
    Serial.print(F("#CH1SET    : 0x")); Serial.println(snap.ch1set,    HEX);
    Serial.print(F("#CH2SET    : 0x")); Serial.println(snap.ch2set,    HEX);
    Serial.print(F("#RLD_SENS  : 0x")); Serial.println(snap.rld_sens,  HEX);
    Serial.print(F("#LOFF_SENS : 0x")); Serial.println(snap.loff_sens, HEX);
    Serial.print(F("#LOFF_STAT : 0x")); Serial.println(snap.loff_stat, HEX);
    Serial.print(F("#RESP1     : 0x")); Serial.println(snap.resp1,     HEX);
    Serial.print(F("#RESP2     : 0x")); Serial.println(snap.resp2,     HEX);
    Serial.print(F("#GPIO      : 0x")); Serial.println(snap.gpio,      HEX);
    Serial.print(F("#SPI Mode  : ")); Serial.println(ads.getWorkingSpiMode());
    Serial.println(F("#---------------------------------"));

    bool allFF   = (snap.id == 0xFF && snap.config1 == 0xFF);
    bool allZero = (snap.id == 0x00 && snap.config1 == 0x00 && snap.ch1set == 0x00);
    if (allFF)        Serial.println(F("#WARNING: All 0xFF -> MISO floating or chip absent"));
    else if (allZero) Serial.println(F("#WARNING: All 0x00 -> Check RESET/CS/MISO/power"));
    else              Serial.println(F("#Registers: real silicon responding"));

    if (snap.ch1set == ADS1292_CH1SET_VAL && snap.ch2set == ADS1292_CH2SET_VAL)
        Serial.println(F("#Gain = 6 confirmed (CH1SET=0x60 CH2SET=0x60)"));
}

// ==========================================================
// Wiring diagnostic
// ==========================================================
static void printWiringChecklist() {
    Serial.println(F("#"));
    Serial.println(F("#=== INIT FAILED — CHECK WIRING ==="));
    Serial.println(F("#"));
    Serial.println(F("#  ESP32 NodeMCU-32S  <->  ADS1292R Breakout v3.1"));
    Serial.println(F("#  -----------------------------------------------"));
    Serial.println(F("#  GPIO18  (SCK)   <->  SCLK"));
    Serial.println(F("#  GPIO19  (MISO)  <->  SDO   *** MOST COMMON MISTAKE ***"));
    Serial.println(F("#  GPIO23  (MOSI)  <->  SDI   (NOT SDO!)"));
    Serial.println(F("#  GPIO5   (CS)    <->  CSn / SS"));
    Serial.println(F("#  GPIO4   (START) <->  START"));
    Serial.println(F("#  GPIO16  (RST)   <->  RST / RESET"));
    Serial.println(F("#  GPIO15  (DRDY)  <->  DRDY"));
    Serial.println(F("#  3.3V            <->  VCC"));
    Serial.println(F("#  3.3V            <->  PWDN  (MUST be HIGH — tie to 3.3V!)"));
    Serial.println(F("#  GND             <->  GND"));
    Serial.println(F("#"));
    Serial.println(F("#  Press RESET button after fixing wiring."));
}

// ==========================================================
// pushSample
// ==========================================================
static void pushSample(int32_t raw24, bool lo, bool loPlusOff, bool loMinusOff) {
    portENTER_CRITICAL(&g_bufMux);
    g_buffers[g_activeBuffer][g_sampleIndex] = raw24;
    g_leadsOff   = lo;
    g_loPlusOff  = loPlusOff;
    g_loMinusOff = loMinusOff;
    g_sampleIndex++;
    if (g_sampleIndex >= WINDOW_SIZE) {
        g_sampleIndex  = 0;
        g_activeBuffer = 1 - g_activeBuffer;
        g_blockSeq++;
        g_blockReady   = true;
    }
    portEXIT_CRITICAL(&g_bufMux);
}

// ==========================================================
// processBlock
// ==========================================================
static void processBlock() {
    int      doneBuffer;
    uint32_t seq;
    bool     lo, loPlus, loMinus;

    portENTER_CRITICAL(&g_bufMux);
    g_blockReady = false;
    doneBuffer   = 1 - g_activeBuffer;
    seq          = g_blockSeq;
    lo           = g_leadsOff;
    loPlus       = g_loPlusOff;
    loMinus      = g_loMinusOff;
    portEXIT_CRITICAL(&g_bufMux);

    Block blk;
    memcpy(blk.data, g_buffers[doneBuffer], sizeof(int32_t) * WINDOW_SIZE);
    blk.seq    = seq;
    blk.lo     = lo;
    blk.loPlus = loPlus;
    blk.loMinus= loMinus;

    if (blk.lo) {
        g_leadOffEvents++;
        pipeline.processBlock(blk);
        Serial.print(F("#LEAD_OFF seq=")); Serial.print(seq);
        if (loPlus)  Serial.print(F(" RA(LO+)"));
        if (loMinus) Serial.print(F(" LA(LO-)"));
        Serial.println();

        // Still upload lead-off blocks so the app can show the warning.
        network_uploadBlock(blk, true, loPlus, loMinus, "LEADS_OFF");
        return;
    }

    String reason;
    bool badQuality = ECGPipeline::validateSamples(blk.data, WINDOW_SIZE, reason);
    if (badQuality) {
        g_invalidBlocks++;
        Serial.print(F("#QUALITY_FAIL seq=")); Serial.print(seq);
        Serial.print(F(" ")); Serial.println(reason);
        pipeline.processBlock(blk);
        // Upload anyway — the Python plotter and server handle quality flags.
        network_uploadBlock(blk, false, loPlus, loMinus, reason.c_str());
        return;
    }

    pipeline.processBlock(blk);

    // -------------------------------------------------------
    // Serial output for live plotting removed as requested.
    // -------------------------------------------------------

    // -------------------------------------------------------
    // Upload to database (non-blocking via FreeRTOS queue).
    // -------------------------------------------------------
    network_uploadBlock(blk, false, loPlus, loMinus, nullptr);
    g_validBlocks++;
}

// ==========================================================
// setup()
// ==========================================================
void setup() {
    Serial.begin(SERIAL_BAUD_RATE);
    delay(800);

    Serial.println(F("#============================================"));
    Serial.println(F("#  SWET_IOT - ECG v11.0 (PlatformIO)"));
    Serial.println(F("#  ESP32 + ProtoCentral ADS1292R v3.1"));
    Serial.println(F("#  WiFi: concurrent AP+STA mode"));
    Serial.println(F("#  Database: ads1292r-code.onrender.com"));
    Serial.println(F("#  Output: RAW signed ADC counts (no scaling)"));
    Serial.println(F("#============================================"));
    Serial.print(F("#SPS       : ")); Serial.println(SAMPLE_RATE);
    Serial.print(F("#Window    : ")); Serial.println(WINDOW_SIZE);
    Serial.println(F("#ADC full-scale: +/-8388607 counts @ gain=6"));
    Serial.println(F("#---"));

    // ADS1292R hardware init (SPI Mode1 → Mode3 auto-fallback).
    ADS1292_Status status = ads.begin();

    if (status != ADS1292_Status::OK) {
        Serial.println(F("#"));
        Serial.println(F("#Pin state (after pin init):"));
        Serial.print(F("#  CS   = ")); Serial.println(digitalRead(ADS1292_CS_PIN));
        Serial.print(F("#  RST  = ")); Serial.println(digitalRead(ADS1292_RESET_PIN));
        Serial.print(F("#  DRDY = ")); Serial.println(digitalRead(ADS1292_DRDY_PIN));
        Serial.print(F("#  MISO = ")); Serial.println(digitalRead(ADS1292_MISO_PIN));
        printWiringChecklist();
        while (true) delay(2000);
    }

    Serial.println(F("#ADS1292R init OK!"));
    ADS1292_RegisterSnapshot snap = ads.dumpRegisters();
    printRegisterSnapshot(snap);

    pipeline.init();
    ads.startConversion();

    Serial.println(F("#ADC streaming @ 125 SPS"));
    Serial.println(F("#Values: signed int32_t, DC-removed, full ADC range"));
    delay(300);

    // WiFi + Upload task init (runs after ADS1292R is stable).
    // WiFiManager may take up to WIFI_CONNECT_TIMEOUT_MS to resolve.
    network_init();

    g_lastRateCheck = millis();
    Serial.println(F("#System ready. Streaming ECG + uploading to database."));
}

// ==========================================================
// loop()
// ==========================================================
void loop() {
    ECGSample sample = ads.readECGSample();

    if (sample.valid) {
        g_totalSamples++;
        g_rateCheckCount++;
        pushSample(sample.channel2,
                   sample.leadOffDetected,
                   sample.loPlusOff,
                   sample.loMinusOff);
    }

    if (g_blockReady) processBlock();

    // WiFi AP/STA watchdog — non-blocking, just updates state.
    network_update();

    uint32_t now = millis();
    if ((now - g_lastRateCheck) >= RATE_CHECK_MS) {
        float sps = (float)g_rateCheckCount /
                    ((float)(now - g_lastRateCheck) / 1000.0f);
        Serial.print(F("#RATE SPS="));   Serial.print(sps, 1);
        Serial.print(F(" total="));      Serial.print(g_totalSamples);
        Serial.print(F(" valid_blk="));  Serial.print(g_validBlocks);
        Serial.print(F(" bad="));        Serial.print(g_invalidBlocks);
        Serial.print(F(" lo_events="));  Serial.println(g_leadOffEvents);
        Serial.print(F("#WiFi STA="));   Serial.print(network_isConnected() ? "UP" : "DOWN");
        Serial.print(F("  AP=ECG_ADS1292R @ "));
        Serial.println(WiFi.softAPIP());
        g_rateCheckCount = 0;
        g_lastRateCheck  = now;
    }
}
