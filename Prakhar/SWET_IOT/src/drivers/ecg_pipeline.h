/**
 * ecg_pipeline.h  — FIR-only version for 125 SPS
 * -----------------------------------------------------------
 * Replaces old IIR (ringing) filters with zero-phase FIR filters 
 * perfectly tuned for the ADS1292R running at 125 SPS.
 * - FIR 50Hz Notch: No ringing.
 * - FIR Low-Pass: 3-tap Hanning window (~31Hz cutoff), no phase shift.
 * - Baseline Wander: 2-stage median correctly tracks huge ADC counts.
 * -----------------------------------------------------------
 */

#pragma once
#include <Arduino.h>
#include "config.h"
#include "types.h"

class ECGPipeline {
public:
    ECGPipeline();

    void init();
    void resetState();

    // Applies filters in-place to blk.data[]
    void processBlock(Block& blk);

    // Runs before processBlock to flag blocks that are pure noise or flatlines.
    static bool validateSamples(const int32_t* samples, int count, String& reason);

private:
    int32_t _median_prev1;
    
    // Baseline wander state
    int _blHistoryCount;
    int _blHistoryHead;
    float _blLastAnchor;
    bool _blInitialized;
    float _blStage1History[125];

    // Notch 50Hz state (IIR version)
    float _notch_x1, _notch_x2;
    float _notch_y1, _notch_y2;
    float _notch_b0, _notch_b1, _notch_b2;
    float _notch_a1, _notch_a2;

    float _workBuf[WINDOW_SIZE];

    // Internal DSP passes
    void _applyMedianSpike(int32_t* data, int len);
    float _medianOfFloats(float* tmp, int n);
    void _removeBaselineWander(float* data, int len);
    
    void _initNotch50Hz(float fs, float f0, float Q);
    void _applyIIRNotch(float* data, int len);
    
    void _applyFIRNotch(float* data, int len);
    void _applyFIRLowPass(float* data, int len);
};
