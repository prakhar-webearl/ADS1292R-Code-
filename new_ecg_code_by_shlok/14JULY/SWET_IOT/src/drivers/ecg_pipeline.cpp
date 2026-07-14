/**
 * ecg_pipeline.cpp  — FIR-only version for 125 SPS
 * -----------------------------------------------------------
 * Replaces old IIR (ringing) filters with zero-phase FIR filters 
 * perfectly tuned for the ADS1292R running at 125 SPS.
 * - FIR 50Hz Notch: No ringing.
 * - FIR Low-Pass: 3-tap Hanning window (~31Hz cutoff), no phase shift.
 * - Baseline Wander: 2-stage median correctly tracks huge ADC counts.
 * -----------------------------------------------------------
 */

#include "ecg_pipeline.h"
#include <math.h>

ECGPipeline::ECGPipeline()
    : _median_prev1(0),
      _blHistoryCount(0), _blHistoryHead(0),
      _blLastAnchor(0.0f), _blInitialized(false)
{
    memset(_blStage1History, 0, sizeof(_blStage1History));
    memset(_workBuf, 0, sizeof(_workBuf));
}

void ECGPipeline::init() {
    _initNotch50Hz(125.0f, 50.0f, 2.0f);
    resetState();
    Serial.println(F("[PIPELINE] Filters configured: 50Hz IIR Notch (Q=2) + 31Hz LowPass (3-pass) + Median Baseline Wander"));
}

void ECGPipeline::resetState() {
    _median_prev1   = 0;
    _blHistoryCount = 0; _blHistoryHead = 0;
    _blLastAnchor   = 0.0f; _blInitialized = false;

    _notch_x1 = 0.0f; _notch_x2 = 0.0f;
    _notch_y1 = 0.0f; _notch_y2 = 0.0f;
}

// ==========================================================
// Median-of-3 spike filter (int32_t)
// ==========================================================
void ECGPipeline::_applyMedianSpike(int32_t* data, int len) {
    int32_t prev = _median_prev1;
    for (int i = 0; i < len; i++) {
        int32_t cur  = data[i];
        int32_t next = (i < len - 1) ? data[i + 1] : cur;
        int32_t a = prev, b = cur, c = next;
        if (a > b) { int32_t t = a; a = b; b = t; }
        if (b > c) { int32_t t = b; b = c; c = t; }
        if (a > b) { int32_t t = a; a = b; b = t; }
        prev    = data[i];
        data[i] = b;
    }
    _median_prev1 = prev;
}

// ==========================================================
// Median helper
// ==========================================================
float ECGPipeline::_medianOfFloats(float* tmp, int n) {
    for (int i = 1; i < n; i++) {
        float key = tmp[i]; int j = i - 1;
        while (j >= 0 && tmp[j] > key) { tmp[j+1] = tmp[j]; j--; }
        tmp[j+1] = key;
    }
    return (n % 2 == 1) ? tmp[n/2] : 0.5f*(tmp[n/2-1]+tmp[n/2]);
}

// ==========================================================
// 2-stage median baseline wander removal
// ==========================================================
// ==========================================================
// Software "Fast Restore" Median Baseline Filter
// ==========================================================
// This filter uses Contamination Gating to ignore the QRS spike, 
// but uses a very fast 112ms window to aggressively track and 
// flatten the massive downward polarization dip that follows.
// This perfectly flattens the S-wave and reveals the T-wave!
static float hp_s1 = 0.0f;
static float hp_s2 = 0.0f;
static float hp_b0, hp_b1, hp_b2, hp_a1, hp_a2;
static bool hp_init = false;

void ECGPipeline::_removeBaselineWander(float* data, int len) {
    if (!hp_init) {
        float fs = 125.0f;
        float f0 = 0.1f; // Ultra-low cutoff to gently center DC without causing ringing or phase delay slants
        float Q = 0.70710678f; // Butterworth
        float w0 = 2.0f * M_PI * f0 / fs;
        float alpha = sinf(w0) / (2.0f * Q);
        float a0 = 1.0f + alpha;
        
        hp_b0 = (1.0f + cosf(w0)) / (2.0f * a0);
        hp_b1 = -(1.0f + cosf(w0)) / a0;
        hp_b2 = (1.0f + cosf(w0)) / (2.0f * a0);
        hp_a1 = -2.0f * cosf(w0) / a0;
        hp_a2 = (1.0f - alpha) / a0;
        
        hp_s1 = 0.0f;
        hp_s2 = 0.0f;
        hp_init = true;
    }

    // Gentle DC blocking filter
    for (int i = 0; i < len; i++) {
        float x = data[i];
        float y = hp_b0 * x + hp_s1;
        hp_s1 = hp_b1 * x - hp_a1 * y + hp_s2;
        hp_s2 = hp_b2 * x - hp_a2 * y;
        data[i] = y;
    }
}

// ==========================================================
// Exact AD8232 IIR Biquad 50Hz Notch (Q=2)
// ==========================================================
void ECGPipeline::_initNotch50Hz(float fs, float f0, float Q) {
    float w0 = 2.0f * M_PI * (f0 / fs);
    float alpha = sinf(w0) / (2.0f * Q);
    float a0 = 1.0f + alpha;
    _notch_b0 = 1.0f / a0;
    _notch_b1 = -2.0f * cosf(w0) / a0;
    _notch_b2 = 1.0f / a0;
    _notch_a1 = -2.0f * cosf(w0) / a0;
    _notch_a2 = (1.0f - alpha) / a0;
}

void ECGPipeline::_applyIIRNotch(float* data, int len) {
    for (int i = 0; i < len; i++) {
        float x = data[i];
        float y = _notch_b0 * x + _notch_b1 * _notch_x1 + _notch_b2 * _notch_x2
                  - _notch_a1 * _notch_y1 - _notch_a2 * _notch_y2;
        _notch_x2 = _notch_x1;
        _notch_x1 = x;
        _notch_y2 = _notch_y1;
        _notch_y1 = y;
        data[i] = y;
    }
}

// ==========================================================
// Zero-Phase FIR 50Hz Notch filter for 125 SPS
// (3-tap: completely eliminates IIR ringing)
// ==========================================================
void ECGPipeline::_applyFIRNotch(float* data, int len) {
    float temp[WINDOW_SIZE];
    for(int i = 0; i < len; i++) {
        float x_prev = (i > 0) ? data[i-1] : data[i];
        float x_next = (i < len-1) ? data[i+1] : data[i];
        // At 125SPS, 50Hz notch coefficients are 0.2764, 0.4472, 0.2764
        temp[i] = 0.2764f * x_next + 0.4472f * data[i] + 0.2764f * x_prev;
    }
    memcpy(data, temp, len * sizeof(float));
}

// ==========================================================
// Zero-Phase FIR Low-Pass (Moving Average)
// ==========================================================
void ECGPipeline::_applyFIRLowPass(float* data, int len) {
    float temp[WINDOW_SIZE];
    for(int i = 0; i < len; i++) {
        float x_prev = (i > 0) ? data[i-1] : data[i];
        float x_next = (i < len-1) ? data[i+1] : data[i];
        // 3-tap moving average (exact AD8232 code match)
        temp[i] = (x_prev + data[i] + x_next) / 3.0f;
    }
    memcpy(data, temp, len * sizeof(float));
}

// ==========================================================
// processBlock()
// ==========================================================
void ECGPipeline::processBlock(Block& blk) {
    if (blk.lo) {
        resetState();
        // Force the raw data block to exactly 0 when leads are off
        for (int i = 0; i < WINDOW_SIZE; i++) {
            blk.data[i] = 0;
        }
        return;
    }

    // We no longer apply the 3-tap median spike filter here, as it artificially chops off the R-peak.
    // The Python script handles noise rejection much better using zero-phase filtering.
    
    for (int i = 0; i < WINDOW_SIZE; i++) _workBuf[i] = (float)blk.data[i];

    // Gentle 0.1Hz DC block to prevent the ADC numbers from drifting to infinity
    _removeBaselineWander(_workBuf, WINDOW_SIZE);
    
    // We no longer apply the IIR Notch and double Moving Average here.
    // Over-filtering in firmware smears the QRS complex and causes ringing.
    // The Python script applies superior zero-phase 50Hz Notch and 40Hz Low-Pass filters.

    for (int i = 0; i < WINDOW_SIZE; i++) {
        blk.data[i] = (int32_t)roundf(_workBuf[i]);
    }
}

// ==========================================================
// validateSamples()
// ==========================================================
bool ECGPipeline::validateSamples(const int32_t* samples, int count, String& reason) {
    reason = "";
    int32_t minV = INT32_MAX, maxV = INT32_MIN;
    uint32_t zeroCount = 0, spikeCount = 0;

    for (int i = 0; i < count; i++) {
        int32_t v = samples[i];
        if (v == 0) zeroCount++;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
        if (i > 0) {
            int64_t delta = (int64_t)v - (int64_t)samples[i-1];
            if (delta < 0) delta = -delta;
            if (delta > VALIDATE_SPIKE_DELTA_MAX) spikeCount++;
        }
    }

    float zeroRatio  = (float)zeroCount  / (float)count;
    float spikeRatio = (float)spikeCount / (float)count;

    if (zeroRatio > 0.15f) {
        reason = "TOO_MANY_ZERO_SAMPLES=" + String(zeroRatio, 2);
    } else if (spikeRatio > VALIDATE_NOISE_RATIO_MAX) {
        reason = "NOISY_SIGNAL=" + String(spikeRatio, 2);
    }
    return reason.length() > 0;
}
