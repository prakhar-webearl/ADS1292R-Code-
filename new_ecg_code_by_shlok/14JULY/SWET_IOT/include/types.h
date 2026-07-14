/**
 * types.h
 * -----------------------------------------------------------
 * SWET_IOT - Shared Types, Enums, Structs
 * Updated: Block.data uses int32_t for full raw ADC range.
 * -----------------------------------------------------------
 */

#pragma once
#include <stdint.h>
#include <stdbool.h>

// ==========================================================
// Driver Status / Result Codes
// ==========================================================
enum class ADS1292_Status : uint8_t {
    OK = 0,
    SPI_ERROR,
    DEVICE_NOT_FOUND,
    REGISTER_MISMATCH,
    NOT_INITIALIZED,
    TIMEOUT
};

// ==========================================================
// Internal Driver State
// ==========================================================
enum class ADS1292_State : uint8_t {
    UNINIT = 0,
    RESET_DONE,
    CONFIGURED,
    RUNNING,
    STOPPED
};

// ==========================================================
// Raw ECG Sample
// ==========================================================
struct ECGSample {
    int32_t  channel1;          // CH1 (respiration) — 24-bit signed
    int32_t  channel2;          // CH2 (ECG)         — 24-bit signed, polarity corrected
    bool     leadOffDetected;
    bool     loPlusOff;         // RA (IN1P / LO+) disconnected
    bool     loMinusOff;        // LA (IN1N / LO-) disconnected
    uint32_t timestamp_ms;
    bool     valid;
};

// ==========================================================
// Register Snapshot
// ==========================================================
struct ADS1292_RegisterSnapshot {
    uint8_t id;
    uint8_t config1;
    uint8_t config2;
    uint8_t loff;
    uint8_t ch1set;
    uint8_t ch2set;
    uint8_t rld_sens;
    uint8_t loff_sens;
    uint8_t loff_stat;
    uint8_t resp1;
    uint8_t resp2;
    uint8_t gpio;
};

// ==========================================================
// Ping-Pong Block  — full raw 24-bit ADC signed values
// NOTE: int32_t (not uint16_t) — NO scaling to [0,4095].
//       Full ADS1292R range: ±8,388,607 counts at gain=6.
// ==========================================================
#define MAX_DEVICE_ID_LEN 32

struct Block {
    int32_t  data[125];     // WINDOW_SIZE raw signed ADC samples
    uint32_t seq;
    bool     lo;
    bool     loPlus;
    bool     loMinus;
};

// ==========================================================
// Wave Measurement (P/T detection)
// ==========================================================
struct WaveMeasurement {
    bool  valid;
    float amplitude;      // signed, in raw ADC counts
    float timeMsFromR;
};
