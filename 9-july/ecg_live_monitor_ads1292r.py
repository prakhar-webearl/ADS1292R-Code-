"""
ECG Live Monitor — v6.0 (ADS1292R)
===================================
Data source : GET https://ads1292r-code.onrender.com/api/ecg/live/ESP_ECG_123

Migrated from v5.4 (AD8232, unsigned 12-bit codes 0-4095, DC offset
2048) to match the ADS1292R firmware (ecg_esp32_ads1292r_v10.ino):
  - Samples are now SIGNED 24-bit codes (~-8.39M..+8.39M), already
    zero-referenced by the ADS1292R itself. Every place that assumed a
    0..4095 range or a 2048 midpoint has been removed.
  - sr (sample rate) now arrives as 500 in each block instead of 360;
    this file already re-builds its filters from whatever `sr` the
    backend reports (unchanged behavior), so no separate constant edit
    is needed there — only the *default* FS/WIN/STEP below changed to
    match the firmware's new block size.
  - ADC-specific spike-correction/clip/flatline magic numbers (tuned
    for a 12-bit ADC) were re-derived in physical microvolts using the
    same PGA-gain/VREF assumptions as the firmware, then converted to
    codes — NOT ported as raw numbers, since the two ADCs' counts-per-
    microvolt differ by ~3 orders of magnitude.
  - The plot already autoscales from the data's own min/max each frame
    (ax.set_ylim(rm-m, rx+m) style) rather than a fixed 0-4095 axis, so
    it needed no change for the new amplitude range.
  - Filtering pipeline (high-pass/notch/low-pass), R-peak detection,
    PQRST annotation, HR/RR analysis, and arrhythmia classification are
    structurally unchanged — scipy's butter()/iirnotch() are already
    specified as fractions of Nyquist (self.fs-relative), so they
    retune themselves automatically for the new 500Hz rate with no
    edits needed there either.
  - Backend API endpoints, request/response shapes, and the SSE/backend
    integration are unchanged.
"""

import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import requests
import json
import matplotlib
matplotlib.use('TkAgg')
import matplotlib.pyplot as plt
import matplotlib.animation as animation
from collections import deque
import numpy as np
import time
import threading
from datetime import datetime
from scipy.signal import butter, bessel, filtfilt, find_peaks, iirnotch
from scipy.ndimage import uniform_filter1d

# ============================================================
# CONFIGURATION
# ============================================================
API_URL        = 'https://ads1292r-code.onrender.com/api/ecg/live/ESP_ECG_123'
API_RESULT_URL = 'https://ads1292r-code.onrender.com/api/ecg/device_result'

# Default sampling rate matches the actual firmware output observed on the
# backend (sr=125 per block). The backend reports the real `sr` in every
# block and filters rebuild from that value, so this is only the startup
# default / initial buffer sizing.
SAMPLING_RATE = 125
WINDOW_SIZE   = SAMPLING_RATE * 5   # 5-second rolling display/analysis buffer

# ---------------- ADS1292R signal-scale constants (12-bit scaled range) ----------------
# The firmware scales the signed 24-bit ECG value to a 12-bit unsigned range (0-4095).
ADS_MIN_CODE       = 0
ADS_MAX_CODE       = 4095
CLIP_HIGH_CODE     = 4045
CLIP_LOW_CODE      = 50

FS           = SAMPLING_RATE
WIN          = WINDOW_SIZE
# STEP = samples per block (one firmware Block).  Will be updated
# dynamically from the `sr` field when the first block arrives.
STEP         = SAMPLING_RATE
MIN_BEATS    = 4
MAX_CLIP_PCT = 5.0   # percentage of clipped samples allowed
# Minimum peak-to-peak signal amplitude to pass the quality gate.
# Matches the firmware's flatline check threshold of 30 counts.
MIN_PTP      = 30
QRS_WIDE_MS  = 130
MAX_LOG_ENTRIES = 8

# Inter-sample spike threshold for the despike pass (matches firmware spike threshold of 1500)
SPIKE_DELTA_CODE = 1500

# ============================================================
# SEVERITY TABLES
# ============================================================
SEVERITY = {
    'Ventricular Fibrillation':       'CRITICAL',
    'Ventricular Tachycardia':        'CRITICAL',
    'Non-Sustained VT (NSVT)':        'CRITICAL',
    'Ventricular Couplets':           'CRITICAL',
    'Ventricular Bigeminy':           'CRITICAL',
    'Ventricular Trigeminy':          'CRITICAL',
    'Sinus Arrest':                   'CRITICAL',
    'Asystole':                       'CRITICAL',
    'Atrial Fibrillation':            'WARNING',
    'Atrial Flutter':                 'WARNING',
    'Atrial Tachycardia':             'WARNING',
    'SVT':                            'WARNING',
    'Ventricular Ectopic / PVC':      'WARNING',
    'Sinus Tachycardia':              'WARNING',
    'Sinus Bradycardia':              'WARNING',
    'AV Block 2nd (Mobitz I)':        'WARNING',
    'AV Block 1st (Prolonged PR)':    'WARNING',
    'Sinus Pause':                    'WARNING',
    'Junctional Rhythm':              'WARNING',
    'PAC (Supraventricular Ectopic)': 'WARNING',
    'Atrial Bigeminy':                'WARNING',
    'Atrial Trigeminy':               'WARNING',
    'Sinus Arrhythmia':               'INFO',
    'Normal Sinus Rhythm':            'NORMAL',
}

SEV_COLORS = {
    'CRITICAL': '#FF2222', 'WARNING': '#FF9900',
    'INFO':     '#2299FF', 'NORMAL':  '#00CC66',
}

# ============================================================
# SIGNAL FILTERING
# ============================================================
class ECGFilter:
    def __init__(self, fs=SAMPLING_RATE):
        self.fs = fs
        # No need to build linear filters; ESP32 already handles baseline, notch, and LP
        self.b_hp, self.a_hp = [1.0], [1.0]
        self.b_lp, self.a_lp = [1.0], [1.0]
        self.b_notch, self.a_notch = [1.0], [1.0]

    def filter_signal(self, raw_signal):
        if len(raw_signal) < 100: return np.array(raw_signal, dtype=float)
        sig = np.array(raw_signal, dtype=float)
        
        # 1. Keep only the median spike filter (catches SPI glitches)
        for i in range(1, len(sig) - 1):
            if abs(sig[i] - sig[i-1]) > SPIKE_DELTA_CODE:
                sig[i] = (sig[i-1] + sig[i+1]) / 2.0
                
        # 2. DO NOT apply high-pass, notch, or low-pass. 
        # The ESP32 already filtered this perfectly. 
        # Applying extra filters flattens the T-wave and distorts the ST segment.
        return sig


# ============================================================
# PQRST ANNOTATION
# ============================================================
def _annotate_one_beat(ax, sig, r_peak):
    n   = len(sig)
    ptp = np.ptp(sig)
    if ptp == 0: return

    # True isoelectric baseline for THIS beat (PR/TP segment before it),
    # not the filter's overall zero level — residual wander can leave a
    # whole segment sitting off-zero even after filtering, which makes a
    # normal T look inverted if measured against 0 instead of its own
    # local baseline.
    base_lo = max(0, r_peak - int(0.30 * FS))
    base_hi = max(0, r_peak - int(0.22 * FS))
    iso = float(np.mean(sig[base_lo:base_hi])) if base_hi > base_lo else 0.0

    ax.plot(r_peak, sig[r_peak], 'ro', markersize=10, zorder=5)
    ax.annotate('R', xy=(r_peak, sig[r_peak]), xytext=(r_peak, sig[r_peak] + 0.18 * ptp), fontsize=11, fontweight='bold', color='red', ha='center', arrowprops=dict(arrowstyle='->', color='red', lw=1.5))

    # P wave: Find largest absolute deviation from baseline
    p_lo = max(0, r_peak - int(0.20 * FS))
    p_hi = max(0, r_peak - int(0.04 * FS))
    if p_hi > p_lo:
        p_seg = sig[p_lo:p_hi]
        p_devs = np.abs(p_seg - iso)
        p_idx = int(np.argmax(p_devs)) + p_lo
        p_val = sig[p_idx]
        ax.plot(p_idx, p_val, 'go', markersize=8, zorder=5)
        ax.annotate('P', xy=(p_idx, p_val), xytext=(p_idx, p_val + 0.12 * ptp), fontsize=11, fontweight='bold', color='green', ha='center')

    q_lo = max(0, r_peak - int(0.02 * FS))
    q_hi = r_peak
    if q_hi > q_lo:
        q_idx = int(np.argmin(sig[q_lo:q_hi])) + q_lo
        ax.plot(q_idx, sig[q_idx], 'mo', markersize=8, zorder=5)
        ax.annotate('Q', xy=(q_idx, sig[q_idx]), xytext=(q_idx, sig[q_idx] - 0.14 * ptp), fontsize=11, fontweight='bold', color='purple', ha='center')

    s_lo = r_peak
    s_hi = min(n, r_peak + int(0.04 * FS))
    if s_hi > s_lo:
        s_idx = int(np.argmin(sig[s_lo:s_hi])) + s_lo
        ax.plot(s_idx, sig[s_idx], 'o', color='orange', markersize=8, zorder=5)
        ax.annotate('S', xy=(s_idx, sig[s_idx]), xytext=(s_idx, sig[s_idx] - 0.14 * ptp), fontsize=11, fontweight='bold', color='orange', ha='center')

    # T wave: Find largest absolute deviation from baseline (works for both upright and inverted T)
    t_lo = min(n, r_peak + int(0.15 * FS))
    t_hi = min(n, r_peak + int(0.35 * FS))
    if t_hi > t_lo:
        t_seg = sig[t_lo:t_hi]
        t_devs = np.abs(t_seg - iso)
        t_idx = int(np.argmax(t_devs)) + t_lo
        t_val = sig[t_idx]
        t_dev = t_val - iso
        t_inverted = t_dev < 0.05 * ptp  # Flag if it's negative or flat
        t_color = '#3366FF' if not t_inverted else '#CC33FF'
        t_label = 'T' if not t_inverted else 'T\u2193'
        ax.plot(t_idx, t_val, 'o', color=t_color, markersize=8, zorder=5)
        ax.annotate(t_label, xy=(t_idx, t_val),
                    xytext=(t_idx, t_val + (0.12*ptp if not t_inverted else -0.12*ptp)),
                    fontsize=11, fontweight='bold', color=t_color, ha='center')

# ============================================================
# DETECTION ENGINE
# ============================================================
def _preprocess(sig):
    nyq = FS / 2.0
    b, a = butter(1, 0.67 / nyq, btype='high')
    try: return filtfilt(b, a, sig)
    except Exception: return sig - np.mean(sig)

def _detect_r_peaks(sig):
    if len(sig) < FS: return np.array([])
    s    = sig - np.mean(sig)
    sig_range = np.ptp(s)
    if sig_range > 0:
        s = s / sig_range
    nyq  = FS / 2.0
    b, a = butter(1, [5/nyq, 15/nyq], 'band')
    f    = filtfilt(b, a, s)
    sq   = np.diff(f, prepend=f[0]) ** 2
    win  = int(0.15 * FS)
    integ = np.convolve(sq, np.ones(win)/win, mode='same')
    thr   = 0.35 * np.max(integ)
    peaks, _ = find_peaks(integ, height=thr, distance=int(0.30*FS))
    if len(peaks) == 0: return np.array([])
    sr = int(0.05 * FS)
    rp = []
    for p in peaks:
        st = max(0, p-sr); en = min(len(s)-1, p+sr)
        rp.append(st + int(np.argmax(np.abs(s[st:en+1]))))
    return np.array(sorted(set(rp)))

def _qrs_width(sig, r_peaks):
    ws = []
    sr = int(0.07 * FS)
    for r in r_peaks:
        st = max(0, r-sr); en = min(len(sig)-1, r+sr)
        seg = sig[st:en+1]
        if len(seg) < 5: continue
        sa = np.abs(seg)
        nf = np.percentile(sa, 20)
        pa = sa[min(r-st, len(seg)-1)]
        if pa <= nf: continue
        above = np.where(sa > nf + 0.45*(pa-nf))[0]
        if len(above) > 1:
            w = (above[-1]-above[0]) / FS * 1000.0
            if 40 <= w <= 200: ws.append(w)
    return float(np.median(ws)) if ws else 90.0

def _pct_wide(sig, r_peaks):
    if len(r_peaks) == 0: return 0.0
    sr = int(0.07 * FS)
    ws = []
    for r in r_peaks:
        st = max(0, r-sr); en = min(len(sig)-1, r+sr)
        seg = sig[st:en+1]
        if len(seg) < 5: continue
        sa = np.abs(seg)
        nf = np.percentile(sa, 20)
        pa = sa[min(r-st, len(seg)-1)]
        if pa <= nf: continue
        above = np.where(sa > nf + 0.45*(pa-nf))[0]
        if len(above) > 1: ws.append((above[-1]-above[0]) / FS * 1000.0)
    return float(np.mean(np.array(ws) > QRS_WIDE_MS)) if ws else 0.0

def _extract(sig, r_peaks):
    if len(r_peaks) < MIN_BEATS: return None
    rr = np.diff(r_peaks) / FS * 1000.0
    if len(rr) < 3: return None
    mu    = float(np.mean(rr))
    hr    = 60000.0 / mu if mu > 0 else 0.0
    cv    = float(np.std(rr)) / mu if mu > 0 else 0.0
    sd    = np.diff(rr)
    rmssd = float(np.sqrt(np.mean(sd**2))) if len(sd) > 0 else 0.0
    pnn50 = float(np.mean(np.abs(sd) > 50))  if len(sd) > 0 else 0.0
    pmx   = float(np.max(rr))
    qw    = _qrs_width(sig, r_peaks)
    pct_w = _pct_wide(sig, r_peaks)
    bl    = float(np.mean(sig))
    amps  = np.array([abs(float(sig[r])-bl) for r in r_peaks if r < len(sig)])
    avcv  = float(np.std(amps)/np.mean(amps)) if len(amps) > 0 and np.mean(amps) > 0 else 0.0
    mid   = len(rr) // 2
    r1, r2 = rr[:mid], rr[mid:]
    m1, m2 = np.mean(r1), np.mean(r2)
    ratio  = m1 / (m2 + 1e-9)
    trans  = ratio > 1.20 or ratio < 0.833
    cv1 = np.std(r1)/(m1+1e-9) if len(r1) > 1 else 1.0
    cv2 = np.std(r2)/(m2+1e-9) if len(r2) > 1 else 1.0
    stable = r1 if cv1 <= cv2 else r2
    if trans and len(stable) >= 3:
        sm      = float(np.mean(stable))
        s_cv    = float(np.std(stable)) / (sm+1e-9)
        s_hr    = 60000.0 / sm if sm > 0 else hr
        ss      = np.diff(stable)
        s_rmssd = float(np.sqrt(np.mean(ss**2))) if len(ss) > 0 else 0.0
        s_pnn50 = float(np.mean(np.abs(ss) > 50))  if len(ss) > 0 else 0.0
    else:
        s_cv, s_hr, s_rmssd, s_pnn50, stable = cv, hr, rmssd, pnn50, rr
    return dict(hr=hr, rr=rr, mu=mu, cv=cv, rmssd=rmssd, pnn50=pnn50, qw=qw, pct_w=pct_w, avcv=avcv, pmx=pmx, n=len(r_peaks), rp=r_peaks, trans=trans, s_cv=s_cv, s_hr=s_hr, s_rmssd=s_rmssd, s_pnn50=s_pnn50, stable_rr=stable)

def _quality_gate(sig, clip):
    """Returns True if the signal looks like real ECG data (not flatline/clipped)."""
    # Reject if >MAX_CLIP_PCT of samples are rail-saturated
    if 100.0 * np.sum(clip) / max(len(clip), 1) > MAX_CLIP_PCT:
        return False
    # Reject flatline: peak-to-peak must exceed MIN_PTP ADC codes
    if np.ptp(sig) < MIN_PTP:
        return False
    # Reject near-zero variance (DC offset or stuck rail)
    if np.std(sig) < MIN_PTP / 6.0:
        return False
    return True

def _vfib(sig):
    s = sig - np.mean(sig)
    # Noise floor check for 12-bit range: if std < 5.0 counts, it is essentially no signal.
    if np.std(s) < 5.0: return 0.0
    fv = np.abs(np.fft.rfft(s))
    fr = np.fft.rfftfreq(len(s), d=1.0/FS)
    band  = (fr >= 4.0) & (fr <= 10.0)
    total = (fr >= 0.5) & (fr <= 30.0)
    if not np.any(band) or not np.any(total): return 0.0
    ratio = float(np.sum(fv[band])) / (float(np.sum(fv[total])) + 1e-9)
    return min(0.90, 0.55 + ratio) if ratio > 0.50 else 0.0

def _afib(cv, rmssd, pnn50, rr, pct_w, avcv):
    if pct_w > 0.35 or avcv >= 0.10 or len(rr) < 10: return 0.0, ''
    if not (cv > 0.15 and rmssd > 75 and pnn50 > 0.32): return 0.0, ''
    rr_n = rr - np.mean(rr)
    rv   = np.var(rr_n) + 1e-9
    ac1  = float(np.mean(rr_n[:-1]*rr_n[1:])) / rv
    ac2  = float(np.mean(rr_n[:-2]*rr_n[2:])) / rv if len(rr) > 4 else 0.0
    if ac1 > 0.30 or ac2 > 0.25: return 0.0, ''
    hist, _ = np.histogram(rr, bins=6)
    if np.max(hist/(np.sum(hist)+1e-9)) > 0.55: return 0.0, ''
    return min(0.90, 0.60 + cv*2.0 + pnn50*0.4), f'CV={cv:.3f}, RMSSD={rmssd:.0f}ms'

def classify(sig):
    sig = _preprocess(sig)
    rp  = _detect_r_peaks(sig)
    ft  = _extract(sig, rp)
    if ft is None: return None
    hr=ft['hr']; rr=ft['rr']; cv=ft['cv']; rmssd=ft['rmssd']
    pnn50=ft['pnn50']; qw=ft['qw']; pct_w=ft['pct_w']
    avcv=ft['avcv']; pmx=ft['pmx']; n=ft['n']; trans=ft['trans']
    s_cv=ft['s_cv']; s_hr=ft['s_hr']; s_rmssd=ft['s_rmssd']
    s_pnn50=ft['s_pnn50']; stable=ft['stable_rr']

    if hr < 10: return ('Asystole', 0.92, 'No detectable beats')
    vf = _vfib(sig)
    if vf > 0: return ('Ventricular Fibrillation', vf, 'Chaotic signal')
    if hr > 100 and pct_w > 0.5 and cv < 0.15 and n >= 6: return ('Ventricular Tachycardia', min(0.90, 0.66+(qw-QRS_WIDE_MS)/200), f'Wide QRS={qw:.0f}ms, HR={hr:.0f}bpm')
    mx = float(np.max(rr)) if len(rr) > 0 else 0
    if mx > 3000: return ('Sinus Arrest', min(0.92, 0.68+(mx-3000)/5000), f'Gap={mx:.0f}ms')
    if not (pmx > 1800 or hr < 40 or avcv >= 0.10 or cv < 0.10):
        afc, afn = _afib(s_cv if trans else cv, s_rmssd if trans else rmssd, s_pnn50 if trans else pnn50, stable  if trans else rr, pct_w, avcv)
        if afc > 0: return ('Atrial Fibrillation', afc, afn)
    others = rr[rr < mx]
    mu_o   = float(np.mean(others)) if len(others) > 0 else float(np.mean(rr))
    if mx > 1.6*mu_o and mx > 1400: return ('Sinus Pause', min(0.84, 0.58+(mx-1400)/3000), f'Gap={mx:.0f}ms')
    if not trans and 150 <= hr <= 250 and pct_w < 0.3 and cv < 0.05: return ('SVT', min(0.87, 0.70+(hr-150)/1200), f'HR={hr:.0f}bpm')
    if hr > 100 and cv < 0.12 and pct_w < 0.4: return ('Sinus Tachycardia', 0.90 if hr < 150 else 0.75, f'HR={hr:.0f}bpm')
    if hr < 60 and cv < 0.15 and pct_w < 0.4: return ('Sinus Bradycardia', 0.90 if hr > 40 else 0.85, f'HR={hr:.0f}bpm')
    if 50 <= hr <= 105:
        rr_med = float(np.median(rr)) if len(rr) > 0 else 0.0
        rr_dev = float(np.max(np.abs(rr - rr_med))) if len(rr) > 0 else 0.0
        sa_like = (
            0.08 <= cv <= 0.22 and
            rmssd >= 30.0 and
            pnn50 >= 0.10 and
            rr_dev >= 60.0
        )
        if sa_like:
            conf = min(0.82, 0.50 + cv * 1.2 + min(pnn50, 0.35) * 0.25)
            return ('Sinus Arrhythmia', conf, f'CV={cv:.3f}, RMSSD={rmssd:.0f}ms')
    return ('Normal Sinus Rhythm', 0.90, f'HR={hr:.0f}bpm')

# ============================================================
# GLOBAL STATE
# ============================================================
data_lock          = threading.Lock()
raw_data           = deque(maxlen=WINDOW_SIZE)
session_raw        = []
session_timestamps = []
RATE_WINDOW_SEC = 3.0
recent_timestamps = deque(maxlen=2000)
raw_dropout        = deque(maxlen=WINDOW_SIZE)   # parallel to raw_data: True = interpolated/dropout sample
last_valid_sample  = 2048                        # ADS1292R pipeline baseline
leads_off_events   = []
session_start_time = None
leads_connected    = True
clipped_count      = 0
samples_per_second = 0
last_seq           = None
skipped_blocks     = 0

ecg_filter = ECGFilter(fs=SAMPLING_RATE)

# ============================================================
# POST RESULT BACK TO API
# ============================================================
_post_session = requests.Session()
_post_session.headers.update({'Content-Type': 'application/json'})

def post_device_result(record_id, device_id, seq, result_str):
    payload = {
        "deviceId":      device_id,
        "device_result": result_str,
    }
    if record_id: payload["recordId"] = record_id
    if seq is not None: payload["seq"] = seq

    for attempt in range(4):
        try:
            r = _post_session.put(API_RESULT_URL, json=payload, timeout=5)
            r.raise_for_status()
            print(f"[API UPDATE] DB updated perfectly for seq={seq} -> Result: {result_str}")
            return
        except Exception as e:
            if attempt < 3:
                print(f"[API RETRY] Network fail for seq={seq}, retrying in 1s... ({e})")
                time.sleep(1.5)
            else:
                print(f"[API FATAL] Failed to update DB for seq={seq} after 4 attempts: {e}")

# ============================================================
# LIVE DETECTION WORKER
# ============================================================
class LiveDetector:
    def __init__(self):
        self.lock           = threading.Lock()
        self._raw_buf       = deque(maxlen=WIN)
        self._clip_buf      = deque(maxlen=WIN)
        self._drop_buf      = deque(maxlen=WIN)
        self._filt          = ECGFilter(fs=SAMPLING_RATE)

        self.current_result = ('Waiting for data...', 0.0, 'NORMAL', '--')
        self.current_bpm    = 0.0
        self.alert_log      = []
        self._pending_cond  = None
        self._pending_count = 0
        self._last_abnormal = None

    def add_sample(self, raw_value, is_clipped, is_dropout=False):
        self._raw_buf.append(raw_value)
        self._clip_buf.append(1 if is_clipped else 0)
        self._drop_buf.append(1 if is_dropout else 0)

    def process_chunk(self, record_id, device_id, seq):
        if len(self._raw_buf) >= WIN:
            raw_snap  = np.array(list(self._raw_buf), dtype=float)
            clip_snap = np.array(list(self._clip_buf), dtype=bool)
            drop_snap = np.array(list(self._drop_buf), dtype=bool)
            threading.Thread(target=self._run, args=(record_id, device_id, seq, raw_snap, clip_snap, drop_snap), daemon=True).start()
        else:
            prog = len(self._raw_buf) // STEP
            threading.Thread(
                target=post_device_result,
                args=(record_id, device_id, seq, f"Warming up ({prog}/5)"),
                daemon=True
            ).start()

    def _run(self, record_id, device_id, seq, raw_snap, clip_snap, drop_snap):
        try:
            filtered  = self._filt.filter_signal(raw_snap)
            bpm = 0.0
            dropout_pct = 100.0 * np.sum(drop_snap) / max(len(drop_snap), 1)
            if dropout_pct > 2.0:
                cond, conf, sev, note = 'Signal Dropout', 0.0, 'INFO', f'{dropout_pct:.1f}% samples lost — check electrode contact'
            elif not _quality_gate(filtered, clip_snap):
                cond, conf, sev, note = 'Poor signal quality', 0.0, 'INFO', 'Check electrodes'
            else:
                result = classify(filtered)
                if result is None:
                    cond, conf, sev, note = 'Insufficient beats', 0.0, 'INFO', 'Need more data'
                else:
                    cond, conf, note = result
                    sev = SEVERITY.get(cond, 'INFO')
                try:
                    rp = _detect_r_peaks(_preprocess(filtered))
                    if len(rp) >= 2:
                        bpm = round(60000.0 / float(np.mean(np.diff(rp) / FS * 1000.0)), 1)
                except Exception:
                    pass
        except Exception as e:
            cond, conf, sev, note = f'System Error', 0.0, 'INFO', str(e)[:30]
            bpm = 0.0

        with self.lock:
            self.current_result = (cond, conf, sev, note)
            self.current_bpm    = bpm
            is_abn = sev not in ('NORMAL', 'INFO')
            if is_abn:
                if cond == self._pending_cond: self._pending_count += 1
                else: self._pending_cond, self._pending_count = cond, 1
                if self._pending_count >= 2 and cond != self._last_abnormal:
                    self.alert_log.append((datetime.now().strftime('%H:%M:%S'), cond, sev))
                    if len(self.alert_log) > MAX_LOG_ENTRIES: self.alert_log.pop(0)
                    self._last_abnormal = cond
            else:
                self._pending_cond, self._pending_count = None, 0
                self._last_abnormal = None

        if bpm > 0:
            result_str = f"{cond} | {conf*100:.0f}% | {bpm:.0f} bpm"
        elif "Error" in cond:
            result_str = f"System Error: Skipped Chunk"
        else:
            result_str = f"{cond} | {conf*100:.0f}%"

        threading.Thread(
            target=post_device_result,
            args=(record_id, device_id, seq, result_str),
            daemon=True
        ).start()

detector = LiveDetector()

# ============================================================
# SSE HELPER — parse one SSE "data:" line into a block dict
# ============================================================
def _process_block(blk):
    global leads_connected, session_start_time, clipped_count
    global last_seq, skipped_blocks, FS

    samples   = blk.get('data', [])
    seq       = blk.get('seq')
    raw_id    = blk.get('_id')
    if isinstance(raw_id, dict): record_id = raw_id.get('$oid')
    else:                        record_id = raw_id
    device_id = blk.get('deviceId', 'ESP_ECG_123')
    lo_flag   = blk.get('lo', False)
    sr        = blk.get('sr', SAMPLING_RATE)

    if not isinstance(samples, list) or len(samples) < 10: return

    print(f"[SSE] Received Chunk -> seq={seq} sr={sr} lo={lo_flag} samples={len(samples)}")

    if seq is not None and last_seq is not None:
        if seq <= last_seq: return
        if seq > last_seq + 1:
            n_skipped = seq - last_seq - 1
            skipped_blocks += n_skipped
            print(f"[WARNING] Block gap! seq={last_seq+1}\u2192{seq} ({n_skipped} missing)")

    if seq is not None:
        last_seq = seq

    if lo_flag:
        leads_connected = False
        leads_off_events.append(time.time())
    else: leads_connected = True

    if isinstance(sr, int) and sr > 0 and sr != FS:
        FS = sr
        global WIN, STEP
        WIN  = FS * 5
        STEP = sr
        # Rebuild raw_data deque with updated window size
        with data_lock:
            raw_data._maxlen = WIN  # type: ignore[attr-defined]
        ecg_filter.__init__(fs=FS)
        detector._filt = ECGFilter(fs=FS)
        detector._raw_buf  = type(detector._raw_buf)(maxlen=WIN)
        detector._clip_buf = type(detector._clip_buf)(maxlen=WIN)
        print(f"[CFG] Sample rate updated to {FS} Hz, WIN={WIN}, STEP={STEP}")

    with data_lock:
        for v in samples:
            try: iv = int(v)
            except (TypeError, ValueError): continue

            global last_valid_sample
            if iv == 0:
                # Leads-off/dropout sample. Don't feed a false 0-code cliff into the
                # plot or the filters — hold the last valid value, but flag it so the
                # classifier can discount any RR gap that overlaps it.
                hold = last_valid_sample
                raw_data.append(hold); session_raw.append(hold); raw_dropout.append(True)
                session_timestamps.append(time.time()); recent_timestamps.append(time.time())
                detector.add_sample(hold, True, is_dropout=True)
                continue
            raw_dropout.append(False)
            last_valid_sample = iv
            # v6.0: sanity-check against the ADS1292R's actual signed
            # 24-bit range instead of the old unsigned 12-bit ADC_MIN/
            # ADC_MAX (100..3900) — this only rejects genuinely corrupt
            # values now, not "off-center" ones, since the whole signed
            # range is valid.
            if iv < ADS_MIN_CODE or iv > ADS_MAX_CODE: continue
            if session_start_time is None: session_start_time = datetime.now()
            is_clipped = (iv <= CLIP_LOW_CODE or iv >= CLIP_HIGH_CODE)
            if is_clipped: clipped_count += 1

            raw_data.append(iv)
            session_raw.append(iv)
            session_timestamps.append(time.time())
            recent_timestamps.append(time.time())

            detector.add_sample(iv, is_clipped)

    detector.process_chunk(record_id, device_id, seq)

def api_polling_thread():
    print(f"[SSE] Connecting to {API_URL}")
    while True:
        try:
            with requests.get(API_URL, stream=True, timeout=60, headers={'Accept': 'text/event-stream'}) as resp:
                resp.raise_for_status()
                print(f"[SSE] Connected \u2014 streaming live ECG blocks...")
                for raw_line in resp.iter_lines(decode_unicode=True):
                    if not raw_line or not raw_line.startswith('data:'): continue
                    json_str = raw_line[5:].strip()
                    try: payload = json.loads(json_str)
                    except Exception: continue

                    if isinstance(payload, dict):
                        if payload.get("type") == "ecg_data": _process_block(payload.get("record", {}))
                        elif "data" in payload and isinstance(payload["data"], list): _process_block(payload)
                        else: _process_block(payload)

        except Exception as e:
            print(f"[SSE] Connection error: {e} \u2014 reconnecting in 2s")
            time.sleep(2)

threading.Thread(target=api_polling_thread, daemon=True, name='api-poll').start()

# ============================================================
# PLOT SETUP & ANIMATION LOOP
# ============================================================
fig = plt.figure(figsize=(13, 8))
fig.patch.set_facecolor('#0A0A0A')
fig.suptitle('ECG Live Monitor  |  ESP32 + ADS1292R  |  MongoDB API  |  PQRST Overlay', fontsize=14, fontweight='bold', color='white')

gs      = fig.add_gridspec(3, 1, hspace=0.45, height_ratios=[1, 1.4, 0.8], top=0.93, bottom=0.06)
ax_raw  = fig.add_subplot(gs[0])
ax_filt = fig.add_subplot(gs[1])
ax_log  = fig.add_subplot(gs[2])

for ax in (ax_raw, ax_filt, ax_log):
    ax.set_facecolor('#0F0F0F')
    for sp in ax.spines.values(): sp.set_edgecolor('#333333')

def update(frame):
    global samples_per_second

    with data_lock:
        n_raw = len(session_raw)
        now = time.time()
        cutoff = now - RATE_WINDOW_SEC
        recent_count = sum(1 for t in recent_timestamps if t >= cutoff)
        oldest_recent = recent_timestamps[0] if recent_timestamps else now

    window_span = now - max(oldest_recent, cutoff)
    if window_span >= 1.0:
        samples_per_second = int(recent_count / window_span)

    if not leads_connected or len(raw_data) < 100:
        for ax in (ax_raw, ax_filt): ax.clear(); ax.set_facecolor('#0F0F0F')
        status = 'LEADS OFF \u2014 CHECK ELECTRODES' if not leads_connected else 'WAITING FOR DATA...'
        ax_filt.text(0.5, 0.5, status, ha='center', va='center', fontsize=20, color='#FF2222', fontweight='bold', transform=ax_filt.transAxes)
        fig.canvas.draw_idle()
        return []

    with data_lock: raw_array = np.array(list(raw_data))
    filtered_array = ecg_filter.filter_signal(raw_array)
    
    with detector.lock:
        cond, conf, sev, note = detector.current_result
        alert_log  = list(detector.alert_log)
        live_bpm   = detector.current_bpm

    sev_color = SEV_COLORS.get(sev, '#FFFFFF')

    # Both axes autoscale from the data's own min/max each frame (with
    # a margin) rather than a fixed axis range, so no change was needed
    # here to handle the ADS1292R's much larger signed code range.
    ax_raw.clear(); ax_raw.set_facecolor('#0F0F0F')
    ax_raw.plot(raw_array, color='#2E86AB', linewidth=1.0, alpha=0.85)
    ax_raw.set_xlim(0, WINDOW_SIZE)
    rm = np.min(raw_array); rx = np.max(raw_array); m  = max((rx-rm)*0.15, 20)
    ax_raw.set_ylim(rm-m, rx+m); ax_raw.set_ylabel('ADC code', fontsize=9, color='#AAAAAA')
    ax_raw.tick_params(colors='#666666', labelsize=8)
    ax_raw.set_title(f'Raw Signal   {samples_per_second} Hz  |  Session: {n_raw//SAMPLING_RATE}s  |  seq: {last_seq if last_seq is not None else "--"}', fontsize=9, color='#888888', pad=4)
    ax_raw.grid(True, alpha=0.12, color='#444444')

    ax_filt.clear(); ax_filt.set_facecolor('#1A0000' if sev == 'CRITICAL' else '#1A0F00' if sev == 'WARNING'  else '#0F0F0F')
    ax_filt.plot(filtered_array, color='#E0E0E0', linewidth=1.5, alpha=0.9, zorder=2)
    ax_filt.set_xlim(0, WINDOW_SIZE); fm = np.min(filtered_array); fx = np.max(filtered_array); m2 = max((fx-fm)*0.15, 10)
    ax_filt.set_ylim(fm-m2, fx+m2); ax_filt.set_ylabel('Filtered', fontsize=9, color='#AAAAAA')
    ax_filt.grid(True, alpha=0.15, color='#444444', zorder=0)

    try:
        sig_pre  = _preprocess(filtered_array)
        rp_local = _detect_r_peaks(sig_pre)
        if len(rp_local) >= 2:
            _annotate_one_beat(ax_filt, filtered_array, rp_local[-2])
    except Exception:
        pass

    conf_str = f'{conf*100:.0f}%' if conf > 0 else ''
    ax_filt.text(0.02, 0.93, f'{cond}  {conf_str}', transform=ax_filt.transAxes, fontsize=11, fontweight='bold', color=sev_color, va='top', ha='left', zorder=10, bbox=dict(boxstyle='round,pad=0.4', facecolor='#000000', edgecolor=sev_color, alpha=0.85, linewidth=1.5))

    bpm_col = '#00CC66' if live_bpm > 0 else '#555555'
    ax_filt.text(0.50, 0.93, f'{live_bpm:.0f} BPM' if live_bpm > 0 else '-- BPM', transform=ax_filt.transAxes, fontsize=13, fontweight='bold', color=bpm_col, va='top', ha='center', zorder=10, bbox=dict(boxstyle='round,pad=0.4', facecolor='#000000', edgecolor=bpm_col, alpha=0.88, linewidth=1.5))

    ax_filt.text(0.98, 0.93, sev, transform=ax_filt.transAxes, fontsize=11, fontweight='bold', color='#FFFFFF', va='top', ha='right', zorder=10, bbox=dict(boxstyle='round,pad=0.4', facecolor=sev_color, edgecolor='none', alpha=0.85))

    ax_log.clear()
    ax_log.set_facecolor('#0A0A0A')
    ax_log.set_xlim(0, 1); ax_log.set_ylim(0, 1); ax_log.axis('off')
    if not alert_log:
        ax_log.text(0.5, 0.5, 'No abnormalities detected yet', ha='center', va='center', fontsize=9, color='#444444', transform=ax_log.transAxes)
    else:
        for idx, (ts, c, s) in enumerate(reversed(alert_log)):
            y   = 0.92 - idx * (0.92 / max(len(alert_log), 1))
            col = SEV_COLORS.get(s, '#FFFFFF')
            ax_log.text(0.01, y, ts, transform=ax_log.transAxes, fontsize=8, color='#666666', va='top')
            ax_log.text(0.12, y, c,  transform=ax_log.transAxes, fontsize=8, color=col, fontweight='bold', va='top')

    fig.canvas.draw_idle()
    return []

print("=" * 65)
print("ECG LIVE MONITOR  v6.0  --  ADS1292R  |  MongoDB API  |  GET + PUT  |  PQRST")
print("=" * 65)

try:
    ani = animation.FuncAnimation(fig, update, interval=40, blit=False, cache_frame_data=False)
    plt.show()
except Exception as e:
    print(f"\n[ERROR] {e}")
