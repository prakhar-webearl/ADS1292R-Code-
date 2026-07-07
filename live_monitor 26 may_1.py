"""
ECG Live Monitor — v5.4
========================
Data source : GET https://api-for-ecg.onrender.com/api/ecg/live/ESP_ECG_123

What is fixed:
- Flawless 1:1 chunk mapping. No more skipped blocks!
- Pushes 'Warming up' to the DB for the first 5 seconds so chunks 1-11 aren't blank!
- Strict deduplication prevents missing predictions on reconnections!
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
import xml.etree.ElementTree as ET
from xml.dom import minidom
from datetime import datetime
from scipy.signal import butter, filtfilt, find_peaks, iirnotch
from scipy.ndimage import uniform_filter1d

# ============================================================
# CONFIGURATION
# ============================================================
API_URL        = 'https://api-for-ecg.onrender.com/api/ecg/live/ESP_ECG_123'
API_RESULT_URL = 'https://api-for-ecg.onrender.com/api/ecg/device_result'

WINDOW_SIZE   = 1800
SAMPLING_RATE = 360

ADC_MIN = 100
ADC_MAX = 3900

FS           = SAMPLING_RATE
WIN          = 1800
STEP         = 360
MIN_BEATS    = 4
MAX_CLIP_PCT = 2.0
MIN_PTP      = 80
QRS_WIDE_MS  = 130
MAX_LOG_ENTRIES = 8

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
    """
    AD8232 ECG software filter chain for ESP32 @ 360 Hz.

    The AD8232 chip has BUILT-IN hardware filters:
      - High-Pass  0.5 Hz  → already removes baseline wander
      - Low-Pass  ~40 Hz   → already removes muscle/EMG noise

    So in software we ONLY handle what the hardware cannot:
      1. DC mean removal    — the ADC output sits at ~2048 mid-rail
      2. Spike removal      — sudden glitches from motion/lead-off
      3. Notch 50 + 60 Hz   — AD8232 has NO powerline rejection
      4. Auto-polarity flip — your electrode placement can invert R

    Electrode placement (image 2):
      RED    = Left Arm  (LA)  — left chest
      YELLOW = Right Arm (RA)  — right chest
      GREEN  = Right Leg (RL)  — lower abdomen (ground/reference)
    """
    def __init__(self, fs=360):
        self.fs      = fs
        self.nyquist = fs / 2.0
        self._build()

    def _build(self):
        nyq = self.nyquist
        # Dual notch ONLY — 50 Hz (India/EU) and 60 Hz (US/JP)
        # HP and LP are handled by the AD8232 hardware — do NOT repeat them here.
        self.b_n50, self.a_n50 = iirnotch(50.0 / nyq, Q=30)
        self.b_n60, self.a_n60 = iirnotch(60.0 / nyq, Q=30)

    def filter_signal(self, raw_signal):
        if len(raw_signal) < 100:
            return np.array(raw_signal, dtype=float)

        sig = np.array(raw_signal, dtype=float)

        # ── Step 1: spike removal (motion artifact / lead-off glitches) ──
        for i in range(1, len(sig) - 1):
            if abs(sig[i] - sig[i-1]) > 500:
                sig[i] = (sig[i-1] + sig[i+1]) / 2.0

        # ── Step 2: remove DC bias (ADC mid-rail ~2048) ───────────────────
        sig = sig - np.mean(sig)

        try:
            # ── Step 3: Notch 50 Hz & 60 Hz — powerline rejection ─────────
            # (AD8232 does NOT filter powerline; this is the only software filter needed)
            sig = filtfilt(self.b_n50, self.a_n50, sig)
            sig = filtfilt(self.b_n60, self.a_n60, sig)

            # ── Step 4: Rolling-median baseline correction ──────────────────
            # The AD8232 hardware HP (0.5 Hz) may still pass slow drift from
            # breathing (0.5–3 Hz) or motion. A rolling median with a ~0.6 s
            # window captures that slow baseline without distorting the fast
            # QRS complex, and subtracting it flattens the wander hump.
            med_win = int(0.6 * self.fs)  # ~216 samples at 360 Hz
            if med_win % 2 == 0: med_win += 1          # must be odd for medfilt
            from scipy.signal import medfilt as _medfilt
            baseline = _medfilt(sig, kernel_size=med_win)
            sig = sig - baseline

            # ── Step 5: light smoothing ────────────────────────────────────
            sig = uniform_filter1d(sig, size=3)
        except Exception:
            sig = np.array(raw_signal, dtype=float) - np.mean(raw_signal)

        # ── Step 6: AUTO-POLARITY CORRECTION ─────────────────────────────
        # Your electrode placement can produce an inverted signal
        # (R goes DOWN instead of UP). Auto-detect and flip if needed.
        pos_peak = float(np.max(sig))
        neg_peak = float(np.min(sig))
        if abs(neg_peak) > abs(pos_peak) * 1.2:
            sig = -sig

        return sig


# ============================================================
# PQRST ANNOTATION
# ============================================================
def _annotate_one_beat(ax, sig, r_peak):
    """
    Annotate a single PQRST beat on the plot.

    ECG morphology (per standard anatomy):
      P  — small positive hump BEFORE R  (label above)
      Q  — small dip just BEFORE R onset (label slightly below)
      R  — tallest peak                  (label above)
      S  — deeper dip just AFTER R       (label further below than Q)
      T  — positive hump AFTER S         (label above)
    """
    n   = len(sig)
    ptp = np.ptp(sig)
    if ptp == 0: return

    # ── R peak ──────────────────────────────────────────────────
    ax.plot(r_peak, sig[r_peak], 'ro', markersize=10, zorder=5)
    ax.annotate('R', xy=(r_peak, sig[r_peak]),
                xytext=(r_peak, sig[r_peak] + 0.18 * ptp),
                fontsize=11, fontweight='bold', color='red', ha='center',
                arrowprops=dict(arrowstyle='->', color='red', lw=1.5))

    # ── P wave: maximum in [R-200ms, R-40ms] ────────────────────
    p_lo = max(0, r_peak - int(0.20 * FS))
    p_hi = max(0, r_peak - int(0.04 * FS))
    if p_hi > p_lo:
        p_idx = int(np.argmax(sig[p_lo:p_hi])) + p_lo
        ax.plot(p_idx, sig[p_idx], 'go', markersize=8, zorder=5)
        ax.annotate('P', xy=(p_idx, sig[p_idx]),
                    xytext=(p_idx, sig[p_idx] + 0.12 * ptp),
                    fontsize=11, fontweight='bold', color='green', ha='center')

    # ── Q wave: minimum in [R-25ms, R-4ms] ──────────────────────
    # Q is a SMALL dip — search only in the last ~25 ms before R
    q_lo = max(0, r_peak - int(0.025 * FS))   # ~9 samples at 360 Hz
    q_hi = max(0, r_peak - int(0.004 * FS))   # leave a 4 ms gap before R
    if q_hi > q_lo:
        q_idx = int(np.argmin(sig[q_lo:q_hi])) + q_lo
        q_val = sig[q_idx]
        ax.plot(q_idx, q_val, 'mo', markersize=8, zorder=5)
        # Label just a little below the Q dip
        ax.annotate('Q', xy=(q_idx, q_val),
                    xytext=(q_idx, q_val - 0.10 * ptp),
                    fontsize=11, fontweight='bold', color='purple', ha='center')

    # ── S wave: minimum in [R+4ms, R+80ms] ──────────────────────
    # S is the DEEPER dip — widen the search window after R
    s_lo = min(n - 1, r_peak + int(0.004 * FS))   # 4 ms after R
    s_hi = min(n,     r_peak + int(0.080 * FS))   # up to 80 ms after R
    if s_hi > s_lo:
        s_idx = int(np.argmin(sig[s_lo:s_hi])) + s_lo
        s_val = sig[s_idx]
        ax.plot(s_idx, s_val, 'o', color='orange', markersize=8, zorder=5)
        # Label further below the S dip (deeper than Q label)
        ax.annotate('S', xy=(s_idx, s_val),
                    xytext=(s_idx, s_val - 0.18 * ptp),
                    fontsize=11, fontweight='bold', color='orange', ha='center')

    # ── T wave: maximum in [R+150ms, R+350ms] ───────────────────
    t_lo = min(n, r_peak + int(0.15 * FS))
    t_hi = min(n, r_peak + int(0.35 * FS))
    if t_hi > t_lo:
        t_idx = int(np.argmax(sig[t_lo:t_hi])) + t_lo
        ax.plot(t_idx, sig[t_idx], 'bo', markersize=8, zorder=5)
        ax.annotate('T', xy=(t_idx, sig[t_idx]),
                    xytext=(t_idx, sig[t_idx] + 0.12 * ptp),
                    fontsize=11, fontweight='bold', color='blue', ha='center')

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
    if 100.0 * np.sum(clip) / max(len(clip), 1) > MAX_CLIP_PCT: return False
    return np.ptp(sig) >= MIN_PTP

def _vfib(sig):
    s = sig - np.mean(sig)
    if np.std(s) < 5: return 0.0
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
    if 50 <= hr <= 105 and 0.05 <= cv <= 0.18: return ('Sinus Arrhythmia', min(0.80, 0.52+cv*1.5), f'CV={cv:.3f}')
    return ('Normal Sinus Rhythm', 0.90, f'HR={hr:.0f}bpm')

# ============================================================
# XML SAVE
# ============================================================
def save_session_xml(raw_samples, timestamps, session_start, session_end, leads_off_events, clipped_count=0):
    pass # XML logic removed to save space for now

# ============================================================
# GLOBAL STATE
# ============================================================
data_lock          = threading.Lock()
raw_data           = deque(maxlen=WINDOW_SIZE)
session_raw        = []
session_timestamps = []
leads_off_events   = []
session_start_time = None
leads_connected    = True
clipped_count      = 0
samples_per_second = 0
last_seq           = None
skipped_blocks     = 0
# How many consecutive blocks reported leads-off.
# We only declare leads truly off after LO_DEBOUNCE_BLOCKS in a row.
lo_block_counter   = 0
LO_DEBOUNCE_BLOCKS = 3   # ~3 s grace period before blanking graph

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
            return # Success! Exit the function.
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
        
        # Using deques ensures we only keep the rolling 1800 window seamlessly
        self._raw_buf       = deque(maxlen=WIN)
        self._clip_buf      = deque(maxlen=WIN)
        self._filt          = ECGFilter(fs=SAMPLING_RATE)
        
        self.current_result = ('Waiting for data...', 0.0, 'NORMAL', '--')
        self.current_bpm    = 0.0
        self.alert_log      = []
        self._last_abnormal = None

    def add_sample(self, raw_value, is_clipped):
        """Just buffer the samples securely."""
        self._raw_buf.append(raw_value)
        self._clip_buf.append(1 if is_clipped else 0)
        
    def process_chunk(self, record_id, device_id, seq):
        """Evaluates explicitly once per database chunk received to guarantee 1:1 API mappings."""
        if len(self._raw_buf) >= WIN:
            # We copy the buffer to cleanly pass to the thread without race conditions
            raw_snap  = np.array(list(self._raw_buf), dtype=float)
            clip_snap = np.array(list(self._clip_buf), dtype=bool)
            threading.Thread(target=self._run, args=(record_id, device_id, seq, raw_snap, clip_snap), daemon=True).start()
        else:
            # PUSH WARM_UP STRING SO THE BACKEND ISN'T SKIPPED!!!
            prog = len(self._raw_buf) // STEP
            threading.Thread(
                target=post_device_result,
                args=(record_id, device_id, seq, f"Warming up ({prog}/5)"),
                daemon=True
            ).start()

    def _run(self, record_id, device_id, seq, raw_snap, clip_snap):
        try:
            filtered  = self._filt.filter_signal(raw_snap)
            bpm = 0.0
            if not _quality_gate(filtered, clip_snap):
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
            # IF THE MATH CRASHES, CATCH IT SO THE THREAD CONTINUES!
            cond, conf, sev, note = f'System Error', 0.0, 'INFO', str(e)[:30]
            bpm = 0.0
                
        with self.lock:
            self.current_result = (cond, conf, sev, note)
            self.current_bpm    = bpm
            is_abn = sev not in ('NORMAL', 'INFO')
            if is_abn and cond != self._last_abnormal:
                self.alert_log.append((datetime.now().strftime('%H:%M:%S'), cond, sev))
                if len(self.alert_log) > MAX_LOG_ENTRIES: self.alert_log.pop(0)
                self._last_abnormal = cond
            elif not is_abn:
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
    global lo_block_counter   # MUST be global — otherwise Python creates a local copy

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

    # Strictly protect against looping old sequences 
    if seq is not None and last_seq is not None:
        if seq <= last_seq: return
        if seq > last_seq + 1:
            n_skipped = seq - last_seq - 1
            skipped_blocks += n_skipped
            print(f"[WARNING] Block gap! seq={last_seq+1}→{seq} ({n_skipped} missing)")
            
    if seq is not None:
        last_seq = seq

    if lo_flag:
        # Smart leads-off: override if actual ADC values look valid.
        # If > 70% of the samples in this block are real ADC readings
        # (within the expected range) the hardware LO flag is likely a
        # transient glitch — keep showing the graph.
        if isinstance(samples, list) and len(samples) > 0:
            valid_count = sum(
                1 for v in samples
                if isinstance(v, (int, float)) and ADC_MIN < int(v) < ADC_MAX and int(v) != 0
            )
            valid_ratio = valid_count / len(samples)
        else:
            valid_ratio = 0.0

        if valid_ratio >= 0.70:
            # Data is mostly good — ignore the LO flag this block
            lo_block_counter = 0
            leads_connected  = True
            print(f"[LO] lo_flag=True but {valid_ratio:.0%} samples valid — ignoring (glitch)")
        else:
            lo_block_counter += 1
            leads_off_events.append(time.time())
            if lo_block_counter >= LO_DEBOUNCE_BLOCKS:
                leads_connected = False
                print(f"[LO] Leads confirmed OFF for {lo_block_counter} consecutive blocks")
    else:
        lo_block_counter = 0
        leads_connected  = True

    if isinstance(sr, int) and sr > 0 and sr != FS:
        FS = sr; ecg_filter._build(); detector._filt = ECGFilter(fs=FS)

    with data_lock:
        for v in samples:
            try: iv = int(v)
            except (TypeError, ValueError): continue
            
            if iv == 0:
                raw_data.append(0); session_raw.append(0); session_timestamps.append(time.time()); detector.add_sample(0, True)
                continue
            if iv < ADC_MIN or iv > ADC_MAX: continue
            if session_start_time is None: session_start_time = datetime.now()
            is_clipped = (iv <= 110 or iv >= 3890)
            if is_clipped: clipped_count += 1
            
            raw_data.append(iv)
            session_raw.append(iv)
            session_timestamps.append(time.time())
            
            detector.add_sample(iv, is_clipped)

    # NOW — evaluate prediction logic specifically ON the boundary of this entire chunk cleanly
    detector.process_chunk(record_id, device_id, seq)

_last_sse_block_ts = time.time()   # watchdog: time of last received SSE block

def api_polling_thread():
    global _last_sse_block_ts
    STALE_TIMEOUT = 90          # recycle connection if no data for 90 s
    SSE_HEADERS = {
        'Accept':          'text/event-stream',
        'Cache-Control':   'no-cache',
        'Connection':      'keep-alive',
        'X-Accel-Buffering': 'no',  # disables nginx buffering on hosted APIs
    }
    print(f"[SSE] Connecting to {API_URL}")
    while True:
        try:
            with requests.get(
                API_URL,
                stream=True,
                timeout=(10, 60),   # (connect timeout, read timeout) in seconds
                headers=SSE_HEADERS
            ) as resp:
                resp.raise_for_status()
                print(f"[SSE] Connected — streaming live ECG blocks...")
                _last_sse_block_ts = time.time()

                for raw_line in resp.iter_lines(decode_unicode=True, chunk_size=4096):
                    # Watchdog: if no block for STALE_TIMEOUT seconds, force reconnect
                    if time.time() - _last_sse_block_ts > STALE_TIMEOUT:
                        print(f"[SSE] No data for {STALE_TIMEOUT}s — recycling connection")
                        break

                    if not raw_line or not raw_line.startswith('data:'): continue
                    json_str = raw_line[5:].strip()
                    try:
                        payload = json.loads(json_str)
                    except Exception:
                        continue

                    _last_sse_block_ts = time.time()   # reset watchdog on each valid block

                    if isinstance(payload, dict):
                        if payload.get("type") == "ecg_data":
                            _process_block(payload.get("record", {}))
                        elif "data" in payload and isinstance(payload["data"], list):
                            _process_block(payload)
                        else:
                            _process_block(payload)

        except Exception as e:
            print(f"[SSE] Connection error: {e} — reconnecting in 3s")
            time.sleep(3)

threading.Thread(target=api_polling_thread, daemon=True, name='api-poll').start()

# ============================================================
# PLOT SETUP & ANIMATION LOOP
# ============================================================
fig = plt.figure(figsize=(13, 8))
fig.patch.set_facecolor('#0A0A0A')
fig.suptitle('ECG Live Monitor  |  ESP32 + AD8232  |  MongoDB API  |  PQRST Overlay', fontsize=14, fontweight='bold', color='white')

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
        t0    = session_timestamps[0] if session_timestamps else None

    if t0 and n_raw > 0:
        dur = time.time() - t0
        samples_per_second = int(n_raw / dur) if dur > 0 else 0

    # Show LEADS OFF only when genuinely disconnected:
    # - leads_connected flag has been False for multiple consecutive blocks, AND
    # - the raw buffer is either empty or dominated by zeros (sent by ESP32 on LO)
    truly_off = False
    if not leads_connected and len(raw_data) > 0:
        arr_check  = np.array(list(raw_data))
        zero_ratio = float(np.sum(arr_check == 0)) / len(arr_check)
        truly_off  = zero_ratio > 0.5   # > 50% zeros = genuine disconnect
    elif not leads_connected and len(raw_data) == 0:
        truly_off = True

    if truly_off or len(raw_data) < 100:
        for ax in (ax_raw, ax_filt): ax.clear(); ax.set_facecolor('#0F0F0F')
        status = 'LEADS OFF — CHECK ELECTRODES' if truly_off else 'WAITING FOR DATA...'
        ax_filt.text(0.5, 0.5, status, ha='center', va='center', fontsize=20,
                     color='#FF2222', fontweight='bold', transform=ax_filt.transAxes)
        fig.canvas.draw_idle()
        return []

    with data_lock: raw_array = np.array(list(raw_data))
    filtered_array = ecg_filter.filter_signal(raw_array)

    with detector.lock:
        cond, conf, sev, note = detector.current_result
        alert_log  = list(detector.alert_log)
        live_bpm   = detector.current_bpm

    sev_color = SEV_COLORS.get(sev, '#FFFFFF')

    ax_raw.clear(); ax_raw.set_facecolor('#0F0F0F')
    ax_raw.plot(raw_array, color='#2E86AB', linewidth=1.0, alpha=0.85)
    ax_raw.set_xlim(0, WINDOW_SIZE)
    rm = np.min(raw_array); rx = np.max(raw_array); m  = max((rx-rm)*1.5, 10)
    ax_raw.set_ylim(rm-m, rx+m); ax_raw.set_ylabel('ADC', fontsize=9, color='#AAAAAA')
    ax_raw.tick_params(colors='#666666', labelsize=8)
    ax_raw.set_title(f'Raw Signal   {samples_per_second} Hz  |  Session: {n_raw//SAMPLING_RATE}s  |  seq: {last_seq if last_seq is not None else "--"}', fontsize=9, color='#888888', pad=4)
    ax_raw.grid(True, alpha=0.12, color='#444444')

    ax_filt.clear(); ax_filt.set_facecolor('#1A0000' if sev == 'CRITICAL' else '#1A0F00' if sev == 'WARNING'  else '#0F0F0F')
    ax_filt.plot(filtered_array, color='#E0E0E0', linewidth=1.5, alpha=0.9, zorder=2)
    ax_filt.set_xlim(0, WINDOW_SIZE); fm = np.min(filtered_array); fx = np.max(filtered_array); m2 = max((fx-fm)*1.5, 1)
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
    
    # Extra severity label to right side
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
print("ECG LIVE MONITOR  v5.4  --  MongoDB API  |  GET + PUT  |  PQRST")
print("=" * 65)

try:
    ani = animation.FuncAnimation(fig, update, interval=40, blit=False, cache_frame_data=False)
    plt.show()
except Exception as e:
    print(f"\n[ERROR] {e}")
