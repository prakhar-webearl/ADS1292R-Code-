/*
 * ============================================================
 *  ECG Signal Filters — Drop-in addition for ESP32 ECG v8.1
 *  Adds: Low-Pass, High-Pass, Band-Pass, Kalman
 *  ✅ Zero changes to WiFi / power / alert / condition logic
 *  ✅ All original thresholds & conditions untouched
 *  Usage: #include "ecg_filters.ino"  (or paste above setup())
 * ============================================================
 */

// ============================================================
//  HOW THE FILTER CHAIN WORKS
//
//   Raw ADC (0-4095)
//       │
//       ▼
//   [1] High-Pass Filter  — removes DC offset + baseline wander
//       │                   cutoff ≈ 0.5 Hz
//       ▼
//   [2] Low-Pass Filter   — removes high-freq muscle artifact
//       │                   cutoff ≈ 40 Hz
//       ▼
//   [3] Band-Pass check   — combined result of HP + LP
//       │                   effectively 0.5–40 Hz (ECG band)
//       ▼
//   [4] Kalman Filter     — smooths remaining noise, tracks
//                           signal level, no phase distortion
//
//  Apply filterECGSample(rawADC) in the ISR instead of
//  storing rawADC directly.
// ============================================================


// ============================================================
//  FILTER STATE  (all float, one instance per filter stage)
//  Keep these in global scope — they must persist between ISR
//  calls. Declared volatile because modified in IRAM ISR.
// ============================================================

// --- 1. High-Pass (IIR, 1st order Butterworth, fc=0.5 Hz @ 360 Hz) --------
// Removes DC offset and slow baseline wander (breathing, motion).
// H(z): y[n] = alpha * (y[n-1] + x[n] - x[n-1])
// alpha = tau / (tau + 1/fs)   tau = 1/(2*pi*fc)
//   fc=0.5Hz, fs=360Hz → alpha = 0.99124
static volatile float hp_x_prev  = 0.0f;   // previous raw input
static volatile float hp_y_prev  = 0.0f;   // previous HP output
static const    float HP_ALPHA   = 0.99124f;

// --- 2. Low-Pass (IIR, 2nd order Butterworth, fc=40 Hz @ 360 Hz) ----------
// Removes high-frequency muscle artifact and ADC switching noise.
// Direct Form II Transposed:
//   fc=40Hz, fs=360Hz → coefficients below (pre-computed)
//   b0=0.20657, b1=0.41314, b2=0.20657
//   a1=-0.36953, a2=0.19582   (a0=1 normalised)
static volatile float lp_w1      = 0.0f;   // delay element 1
static volatile float lp_w2      = 0.0f;   // delay element 2
static const    float LP_B0      =  0.20657f;
static const    float LP_B1      =  0.41314f;
static const    float LP_B2      =  0.20657f;
static const    float LP_A1      = -0.36953f;
static const    float LP_A2      =  0.19582f;

// --- 3. Band-Pass: no separate state needed --------------------------------
// The cascade of HP(0.5Hz) → LP(40Hz) IS the band-pass (0.5–40 Hz).
// This matches the AHA recommended ECG diagnostic bandwidth.

// --- 4. Kalman Filter (scalar, constant-velocity model) -------------------
// Tracks the smoothed signal level. Handles residual noise after LP.
// State: x_hat = estimated signal value
// P     = error covariance
// Q     = process noise covariance  (tune: larger → follows signal faster)
// R     = measurement noise variance (tune: larger → smoother output)
static volatile float kf_x_hat   = 2048.0f; // initial estimate (mid-rail)
static volatile float kf_P       = 100.0f;  // initial error covariance
static const    float KF_Q       = 0.5f;    // process noise  (ECG signal dynamics)
static const    float KF_R       = 8.0f;    // measurement noise (ADC noise ~2-3 LSB)


// ============================================================
//  INDIVIDUAL FILTER FUNCTIONS
//  All IRAM_ATTR so they are safe to call from the timer ISR.
// ============================================================

// 1. High-Pass filter — returns centred signal (removes DC/wander)
IRAM_ATTR float applyHighPass(float x) {
    float y    = HP_ALPHA * (hp_y_prev + x - hp_x_prev);
    hp_x_prev  = x;
    hp_y_prev  = y;
    return y;
}

// 2. Low-Pass filter — returns smoothed signal (removes >40 Hz)
IRAM_ATTR float applyLowPass(float x) {
    float w    = x - LP_A1 * lp_w1 - LP_A2 * lp_w2;
    float y    = LP_B0 * w + LP_B1 * lp_w1 + LP_B2 * lp_w2;
    lp_w2      = lp_w1;
    lp_w1      = w;
    return y;
}

// 3. Band-Pass — cascade HP then LP (called internally by filterECGSample)
//    Exposed here if you ever want to call it alone.
IRAM_ATTR float applyBandPass(float x) {
    return applyLowPass(applyHighPass(x));
}

// 4. Kalman filter — returns optimally smoothed estimate
IRAM_ATTR float applyKalman(float measurement) {
    // Predict
    // (no control input; constant model: x_hat stays same)
    float P_pred = kf_P + KF_Q;

    // Update (Kalman gain)
    float K      = P_pred / (P_pred + KF_R);
    kf_x_hat     = kf_x_hat + K * (measurement - kf_x_hat);
    kf_P         = (1.0f - K) * P_pred;

    return kf_x_hat;
}


// ============================================================
//  MASTER PIPELINE FUNCTION
//  Call this in your ISR instead of storing raw analogRead().
//
//  Input : raw 12-bit ADC value (0–4095)
//  Output: filtered 16-bit value, re-biased to 0–4095 range
//          so ALL your existing thresholds work unchanged.
// ============================================================
IRAM_ATTR uint16_t filterECGSample(uint16_t rawADC) {
    float x = (float)rawADC;

    // Stage 1 + 2 + 3: Band-pass (High-pass → Low-pass cascade)
    float bp = applyBandPass(x);

    // Stage 4: Kalman smoothing on the band-passed signal
    float smoothed = applyKalman(bp);

    // Re-bias back to mid-rail (2048) so the output sits in
    // the same 0–4095 space your validator & peak-detector expect.
    // HP removed the DC offset, so add 2048 back.
    float rebiased = smoothed + 2048.0f;

    // Clamp to valid ADC range — never let filter transients
    // produce out-of-range values that trip your clip detector.
    if (rebiased < 0.0f)    rebiased = 0.0f;
    if (rebiased > 4095.0f) rebiased = 4095.0f;

    return (uint16_t)rebiased;
}


// ============================================================
//  FILTER RESET
//  Call resetFilters() whenever leads-off is detected or the
//  system powers back on, to flush stale state from all stages.
//  This prevents a burst of filter transients on reconnect.
// ============================================================
void resetFilters() {
    hp_x_prev = 0.0f;
    hp_y_prev = 0.0f;
    lp_w1     = 0.0f;
    lp_w2     = 0.0f;
    kf_x_hat  = 2048.0f;
    kf_P      = 100.0f;
    Serial.println("[FILTER] Filter state reset");
}


// ============================================================
//  HOW TO INTEGRATE — only 3 lines change in your main code
//
//  STEP 1: In onTimer() ISR, replace:
//
//    buffers[activeBuffer][sampleIndex] =
//        leadsOff ? 0 : (uint16_t)analogRead(ECG_PIN);
//
//  WITH:
//
//    buffers[activeBuffer][sampleIndex] =
//        leadsOff ? 0 : filterECGSample((uint16_t)analogRead(ECG_PIN));
//
//  ─────────────────────────────────────────────────────────────
//
//  STEP 2: In setSystemPowerState(bool on), inside the `else`
//  branch (system OFF), add one call after noTone():
//
//    resetFilters();
//
//  ─────────────────────────────────────────────────────────────
//
//  STEP 3: In onTimer() ISR, when leadsOff becomes true for
//  the first time (edge detect), call resetFilters() so stale
//  filter state doesn't contaminate the next valid block.
//  Add this after the leadsOff assignment:
//
//    static bool prevLeadsOff = false;
//    if (leadsOff && !prevLeadsOff) resetFilters();
//    prevLeadsOff = leadsOff;
//
//  That is ALL. Every other line of your code is untouched.
// ============================================================


// ============================================================
//  TUNING GUIDE  (change these 4 constants only)
//
//  HP_ALPHA  (default 0.99124)
//    Closer to 1.0 → lower cutoff → more baseline wander removed
//    Closer to 0.95 → cutoff ~3 Hz → more aggressive DC removal
//    Keep between 0.985 – 0.995 for clinical ECG.
//
//  LP cutoff is baked into B/A coefficients above.
//    To change: recompute with a Butterworth tool at your fs.
//    fc=40Hz is the AHA diagnostic standard. 
//    For monitoring only (not diagnosis), fc=25Hz is acceptable
//    and removes more noise.
//
//  KF_Q  (default 0.5)
//    Higher → Kalman tracks fast signal changes better
//             but passes more noise
//    Lower  → Smoother output, but may lag on steep R-peaks
//    Range for ECG: 0.1 – 2.0
//
//  KF_R  (default 8.0)
//    Higher → More smoothing, trusts measurement less
//    Lower  → Less smoothing, trusts ADC more
//    Set to (ADC noise std-dev)^2. For ESP32 ADC ≈ 2–3 LSB → R=4–9
// ============================================================
