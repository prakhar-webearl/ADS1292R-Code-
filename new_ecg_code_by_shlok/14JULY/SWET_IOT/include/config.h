/**
 * config.h  — Register values corrected to match ProtoCentral library exactly
 */

#pragma once

// ==========================================================
// Serial
// ==========================================================
#define SERIAL_BAUD_RATE            115200

// ==========================================================
// SPI
// ==========================================================
#define ADS1292_SPI_CLOCK_HZ         1000000UL  // 1 MHz
#define ADS1292_SPI_BIT_ORDER        MSBFIRST
#define ADS1292_SPI_MODE             SPI_MODE1   // CPOL=0, CPHA=1

// ==========================================================
// Timing
// ==========================================================
#define ADS1292_RESET_PULSE_MS       100   // match ProtoCentral: 100 ms reset pulse
#define ADS1292_POWERUP_DELAY_MS     150
#define ADS1292_DRDY_TIMEOUT_MS      200

// ==========================================================
// Sampling — 125 SPS (CONFIG1 = 0x00)
// ==========================================================
#define SAMPLE_RATE                  125
#define WINDOW_SIZE                  125

// ==========================================================
// ADS1292R Register Values — EXACTLY from ProtoCentral library
// (protocentralAds1292r.cpp ads1292Init)
// ==========================================================
#define ADS1292_CONFIG1_VAL          0x00          // 125 SPS
#define ADS1292_CONFIG2_VAL          0b11100000    // 0xE0 — Lead-off comp POWERED UP (bit 6 = 1)
#define ADS1292_LOFF_VAL             0b00010000    // 0x10 — Lead-off defaults (95%, 6nA)
#define ADS1292_CH1SET_VAL           0b00000000    // 0x00 — Ch1 enabled, gain 6, electrode in
#define ADS1292_CH2SET_VAL           0b00000000    // 0x00 — Ch2 enabled, gain 6, electrode in
#define ADS1292_RLD_SENS_VAL         0b00101100    // 0x2C — RLD sensing on Ch2 (P and N)
#define ADS1292_LOFF_SENS_VAL        0b00001100    // 0x0C — LOFF sensing enabled on CH2P and CH2N (bits 2 and 3)
#define ADS1292_RESP1_VAL            0b00000010    // 0x02 — Respiration MOD/DEMOD OFF (Prevents downward T-wave polarization artifact!)
#define ADS1292_RESP2_VAL            0b00000011    // 0x03 — Calib OFF, respiration freq defaults

// ==========================================================
// Signal Polarity Fix
// ==========================================================
// 0 = output raw CH2 as-is (ProtoCentral-matched init → QRS is already UPRIGHT)
// 1 = negate CH2 (only needed if QRS still points down after testing with 0)
#define ECG_INVERT_CH2               0

// ==========================================================
// Baseline Wander Removal (median-based)
// ==========================================================
#define BL_STAGE1_WIN                25         // 200ms chunk (creates a 2-stage voting system)
#define BL_CANDS_PER_BLOCK           (WINDOW_SIZE / BL_STAGE1_WIN)
#define BL_STAGE2_WIN                5          // Median of 5 chunks (ensures TP segment wins the vote)
#define BL_HISTORY_LEN               16
#define BL_MAX_STEP_PER_CAND         1500.0f    // Fast enough to track breathing wander, slow enough to ignore waves
#define BL_CONTAM_PTP_THRESHOLD      8000.0f    // raw ADC counts

// ==========================================================
// FIR Low-Pass (3-tap double-pass ≈ 40 Hz @ 125 SPS)
// ==========================================================
#define LP_MOVING_AVG_WIN            3

// ==========================================================
// Validation
// ==========================================================
#define VALIDATE_SPIKE_DELTA_MAX     20000
#define VALIDATE_NOISE_RATIO_MAX     0.125f

// ==========================================================
// Debug
// ==========================================================
#define DEBUG_ENABLED                1
#if DEBUG_ENABLED
    #define DBG_PRINT(x)     Serial.print(x)
    #define DBG_PRINTLN(x)   Serial.println(x)
    #define DBG_PRINTF(...)  Serial.printf(__VA_ARGS__)
#else
    #define DBG_PRINT(x)
    #define DBG_PRINTLN(x)
    #define DBG_PRINTF(...)
#endif

// ==========================================================
// WiFi & Network
// ==========================================================
#define WIFI_AP_SSID                 "ECG_Setup"   // AP SSID when in setup mode
#define WIFI_AP_PASSWORD             "12345678"        // AP password (min 8 chars)
#define WIFI_AP_TIMEOUT_MS           15000             // Start AP if STA disconnected 15s
#define WIFI_RECONNECT_INTERVAL_MS   5000              // Try STA reconnect every 5s
#define WIFI_CONNECT_TIMEOUT_MS      10000             // Initial STA connect timeout

// ==========================================================
// Hardware
// ==========================================================
#define LED_PIN                      2                 // Built-in blue LED (GPIO2)

// ==========================================================
// Database / API
// ==========================================================
#define API_HOST                     "ads1292r-code.onrender.com"
#define API_ENDPOINT                 "/api/ecg"        // POST endpoint (NOT the SSE /live/ path!)
#define API_DEVICE_ID                "ESP_ECG_123"
#define API_USER_ID                  "ESP_ECG_123"     // Default userId = deviceId
#define API_TIMEOUT_MS               8000              // HTTP POST timeout
#define NVS_NAMESPACE                "ecg_cfg"         // Preferences namespace (matches AD8232)

// ==========================================================
// FreeRTOS Upload Queue
// ==========================================================
#define UPLOAD_QUEUE_DEPTH           10                // Max blocks queued for upload (handles latency spikes)
