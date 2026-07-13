/**
 * ecg_pipeline.h  — Raw ADC version
 * -----------------------------------------------------------
 * Pipeline operates on full-range signed int32_t values.
 * No scaling to [0,4095]. Output retains the native ADS1292R
 * ADC count range (±8,388,607 at gain=6, VREF=2.42V).
 * -----------------------------------------------------------
 */

#pragma once
#include <Arduino.h>
#include "config.h"
#include "types.h"
#include "ecg_pc_filter.h"

// NOTE: BL_STAGE1_WIN, BL_STAGE2_WIN, BL_HISTORY_LEN, BL_MAX_STEP_PER_CAND,
//       BL_CONTAM_PTP_THRESHOLD and BL_CANDS_PER_BLOCK are defined in config.h.

class ECGPipeline {
public:
    ECGPipeline();

    void init();
    void resetState();

    // Apply full filter pipeline to blk.data[] (int32_t, full ADC range).
    // On lead-off: resets state, does not filter.
    void processBlock(Block& blk);

    // Signal quality check on raw int32_t samples.
    // Returns true if a quality issue is detected.
    static bool validateSamples(const int32_t* samples, int count, String& reason);

private:
    // Median spike filter state
    int32_t _median_prev1;

    void  _applyFIRNotch(float* data, int len);
    void  _applyIIRNotch(float* data, int len);
    void  _applyFIRLowPass(float* data, int len);

    // Notch state
    float _notch_b0, _notch_b1, _notch_b2;
    float _notch_a1, _notch_a2;
    float _notch_x1, _notch_x2;
    float _notch_y1, _notch_y2;

    // Baseline wander removal state
    float _blStage1History[BL_HISTORY_LEN];
    int   _blHistoryCount;
    int   _blHistoryHead;
    float _blLastAnchor;
    bool  _blInitialized;

    float _workBuf[WINDOW_SIZE];

    void  _initNotch50Hz(float fs, float f0 = 50.0f, float Q = 2.0f);
    void  _applyMedianSpike(int32_t* data, int len);
    void  _removeBaselineWander(float* data, int len);
    static float _medianOfFloats(float* tmp, int n);
};
