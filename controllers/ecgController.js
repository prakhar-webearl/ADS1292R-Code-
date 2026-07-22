import EcgData from "../models/EcgData.js";
import MonitorEcgData from "../models/MonitorEcgData.js";
import TwelveLeadEcg from "../models/TwelveLeadEcg.js";
import Abnormality from "../models/abnormalityModel.js";
import User from "../models/userModel.js";
import AddedUser from "../models/userAddModel.js";
import Notification from "../models/notificationModel.js";
import { emitNewNotification } from "../services/notificationSocket.js";
import { createAdminNotification } from "./adminNotification.Controller.js";
import mongoose from "mongoose";

// Array to hold connected Live Stream (SSE) clients
export let liveClients = [];
export let monitorLiveClients = [];

const MONITOR_WINDOW_SECONDS = 12;
const monitorSessions = new Map();
const monitorBuffers = new Map();
const lastEcgPostAtByKey = new Map();
const disconnectTimeoutsByKey = new Map();
const activeStreamKeyByTargetUserId = new Map();
const activeLeadSessions = new Map();
const ECG_STREAM_RECONNECT_GAP_MS = Number(process.env.ECG_STREAM_RECONNECT_GAP_MS || 8000);

const monitorKey = (deviceId, userId) => `${deviceId}::${userId}`;

const getLatestAbnormalitiesForMonitorWindow = async (userId, deviceId, windowStart, windowEnd) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return [];
  }

  const docs = await Abnormality.find({
    userId: new mongoose.Types.ObjectId(userId),
    deviceId,
  })
    .sort({ lastUpdated: -1 })
    .limit(30)
    .lean();

  const flattened = docs.flatMap((doc) =>
    (doc.abnormalities || []).map((abn) => ({
      timestamp: abn.timestamp,
      abnormalityName: abn.abnormalityName,
      severity: abn.severity,
      confidence: abn.confidence,
      bpm: abn.bpm,
      data: Array.isArray(abn.data) ? abn.data : [],
      additionalData: abn.additionalData || {},
      sourceDate: doc.date,
    }))
  );

  // Only include abnormalities that were detected within this specific window's time range
  const windowStartMs = windowStart ? new Date(windowStart).getTime() : 0;
  const windowEndMs = windowEnd ? new Date(windowEnd).getTime() : Date.now();

  const filtered = flattened.filter((abn) => {
    const ts = new Date(abn.timestamp).getTime();
    return ts >= windowStartMs && ts <= windowEndMs;
  });

  filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return filtered;
};

const storeLatestMonitorWindow = async ({
  userId,
  deviceId,
  windowChunks,
}) => {
  const mergedData = windowChunks.flatMap((chunk) => chunk.data);
  const windowStart = windowChunks[0].at;
  const windowEnd = windowChunks[windowChunks.length - 1].at;

  // Fetch only abnormalities detected within this specific 12-second window
  const windowAbnormalities = await getLatestAbnormalitiesForMonitorWindow(
    userId,
    deviceId,
    windowStart,
    windowEnd,
  );

  return MonitorEcgData.create({
    userId,
    deviceId,
    fromSeq: windowChunks[0].seq,
    toSeq: windowChunks[windowChunks.length - 1].seq,
    sr: windowChunks[0].sr,
    lo: windowChunks.some((chunk) => chunk.lo === true),
    mode: windowChunks[0].mode || undefined,
    data: mergedData,
    abnormalities: windowAbnormalities,
    sampleCount: mergedData.length,
    durationSeconds: MONITOR_WINDOW_SECONDS,
    startedAt: windowStart,
    endedAt: windowEnd,
    monitor: true,
  });
};

const normalizeMonitorFlag = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  if (typeof value === "number") return value === 1;
  return fallback;
};

const resolveNotificationUserName = async (effectiveUserId) => {
  let userName = "User";

  if (!mongoose.Types.ObjectId.isValid(effectiveUserId)) {
    return userName;
  }

  const mainUser = await User.findById(effectiveUserId).lean();
  if (mainUser?.full_name) {
    return mainUser.full_name;
  }

  const addedUser = await AddedUser.findById(effectiveUserId).lean();
  if (addedUser?.full_name) {
    return addedUser.full_name;
  }

  return userName;
};

const resolveNotificationTargetUserId = async (effectiveUserId) => {
  if (!mongoose.Types.ObjectId.isValid(effectiveUserId)) {
    return effectiveUserId;
  }

  const mainUser = await User.findById(effectiveUserId).select("_id").lean();
  if (mainUser?._id) {
    return String(mainUser._id);
  }

  const addedUser = await AddedUser.findById(effectiveUserId).select("createdBy").lean();
  if (addedUser?.createdBy) {
    return String(addedUser.createdBy);
  }

  return effectiveUserId;
};

const scheduleDeviceDisconnectNotification = (
  key,
  deviceId,
  targetUserId,
) => {
  const existingTimeout = disconnectTimeoutsByKey.get(key);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  const timeoutId = setTimeout(async () => {
    disconnectTimeoutsByKey.delete(key);

    // Safety guard: only notify when no POST data has arrived for the full gap window.
    const lastPostAtMs = lastEcgPostAtByKey.get(key);
    const isStillInactive = !lastPostAtMs || Date.now() - lastPostAtMs >= ECG_STREAM_RECONNECT_GAP_MS;
    if (!isStillInactive) {
      return;
    }

    try {
      const disconnectNotification = await Notification.create({
        title: `ECG Device Disconnected`,
        notification: `Device disconnected due to no ECG data`,
        details: `No ECG data received for device ${deviceId}`,
        targetUserId,
      });

      emitNewNotification(disconnectNotification);

      // Also notify admin
      await createAdminNotification({
        title: `ECG Device Disconnected`,
        desc: `Device ${deviceId} disconnected from user ${targetUserId}`,
        type: "ALERT",
        category: "WARNING",
        metadata: { deviceId, targetUserId }
      });
    } catch (notificationError) {
      console.error(`Error creating ECG disconnect notification: ${notificationError.message}`);
    }

    // Clear stream-owner mapping only when this key is still the active key.
    if (targetUserId && activeStreamKeyByTargetUserId.get(targetUserId) === key) {
      activeStreamKeyByTargetUserId.delete(targetUserId);
    }
  }, ECG_STREAM_RECONNECT_GAP_MS);

  disconnectTimeoutsByKey.set(key, timeoutId);
};

const ECG_STANDARD_RANGES = {
  prIntervalMs: "100 ms - 200 ms",
  qrsIntervalMs: "60 ms - 120 ms",
  qtIntervalMs: "300 ms - 450 ms",
  qtcIntervalMs: "300 ms - 450 ms",
  heartRateBpm: "60 bpm - 100 bpm",
};

const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

const stdDev = (arr) => {
  if (!arr.length) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) * (v - m), 0) / arr.length;
  return Math.sqrt(variance);
};

const median = (arr) => {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const argMinInRange = (arr, start, end) => {
  let idx = start;
  let minVal = arr[start];
  for (let i = start + 1; i < end; i += 1) {
    if (arr[i] < minVal) {
      minVal = arr[i];
      idx = i;
    }
  }
  return idx;
};

const argMaxInRange = (arr, start, end) => {
  let idx = start;
  let maxVal = arr[start];
  for (let i = start + 1; i < end; i += 1) {
    if (arr[i] > maxVal) {
      maxVal = arr[i];
      idx = i;
    }
  }
  return idx;
};

const detectRPeaks = (samples, sr) => {
  if (!Array.isArray(samples) || samples.length < sr) return [];

  const m = mean(samples);
  const centered = samples.map((v) => v - m);
  const sigma = stdDev(centered);

  let maxV = centered[0];
  let minV = centered[0];
  for (let i = 1; i < centered.length; i += 1) {
    if (centered[i] > maxV) maxV = centered[i];
    if (centered[i] < minV) minV = centered[i];
  }

  const threshold = Math.max(sigma * 1.2, (maxV - minV) * 0.22);
  const refractory = Math.max(1, Math.floor(0.25 * sr));
  const peaks = [];

  for (let i = 1; i < centered.length - 1; i += 1) {
    const isPeak = centered[i] > centered[i - 1] && centered[i] >= centered[i + 1] && centered[i] >= threshold;
    if (!isPeak) continue;

    if (!peaks.length || i - peaks[peaks.length - 1] > refractory) {
      peaks.push(i);
    } else {
      const lastIdx = peaks[peaks.length - 1];
      if (centered[i] > centered[lastIdx]) {
        peaks[peaks.length - 1] = i;
      }
    }
  }

  return peaks;
};

const computeMonitorEcgTable = (record) => {
  const samples = Array.isArray(record?.data) ? record.data : [];
  const sr = Number.isFinite(record?.sr) && record.sr > 0 ? record.sr : 360;

  if (!samples.length) {
    return {
      observedValues: {
        prIntervalMs: null,
        qrsIntervalMs: null,
        qtIntervalMs: null,
        qtcIntervalMs: null,
        heartRateBpm: null,
      },
      standardRanges: ECG_STANDARD_RANGES,
      qualityScore: {
        score: 0,
        label: "Poor",
      },
    };
  }

  const rPeaks = detectRPeaks(samples, sr);
  const rrMs = [];
  for (let i = 0; i < rPeaks.length - 1; i += 1) {
    rrMs.push(((rPeaks[i + 1] - rPeaks[i]) / sr) * 1000);
  }

  const prVals = [];
  const qrsVals = [];
  const qtVals = [];

  for (let i = 1; i < rPeaks.length - 1; i += 1) {
    const r = rPeaks[i];

    const pStart = Math.max(0, r - Math.floor(0.22 * sr));
    const pEnd = Math.max(pStart + 1, r - Math.floor(0.06 * sr));
    const qStart = Math.max(0, r - Math.floor(0.04 * sr));
    const qEnd = Math.max(qStart + 1, r);
    const sStart = r;
    const sEnd = Math.min(samples.length, r + Math.floor(0.06 * sr));
    const tStart = Math.min(samples.length - 1, r + Math.floor(0.12 * sr));
    const tEnd = Math.min(samples.length, r + Math.floor(0.42 * sr));

    if (pEnd <= pStart || qEnd <= qStart || sEnd <= sStart || tEnd <= tStart) {
      continue;
    }

    const pPeak = argMaxInRange(samples, pStart, pEnd);
    const qIdx = argMinInRange(samples, qStart, qEnd);
    const sIdx = argMinInRange(samples, sStart, sEnd);
    const tPeak = argMaxInRange(samples, tStart, tEnd);

    const pOnset = Math.max(0, pPeak - Math.floor(0.04 * sr));
    const qrsOnset = Math.max(0, qIdx - Math.floor(0.02 * sr));
    const tOffset = Math.min(samples.length - 1, tPeak + Math.floor(0.08 * sr));

    const pr = ((qrsOnset - pOnset) / sr) * 1000;
    const qrs = ((sIdx - qrsOnset) / sr) * 1000;
    const qt = ((tOffset - qrsOnset) / sr) * 1000;

    if (pr >= 60 && pr <= 320) prVals.push(pr);
    if (qrs >= 40 && qrs <= 220) qrsVals.push(qrs);
    if (qt >= 180 && qt <= 600) qtVals.push(qt);
  }

  const rrMedian = median(rrMs);
  const qtMedian = median(qtVals);

  const heartRate = rrMedian ? 60000 / rrMedian : null;
  const qtc = rrMedian && qtMedian ? qtMedian / Math.sqrt(rrMedian / 1000) : null;

  const observedValues = {
    prIntervalMs: median(prVals) != null ? Math.round(median(prVals)) : null,
    qrsIntervalMs: median(qrsVals) != null ? Math.round(median(qrsVals)) : null,
    qtIntervalMs: qtMedian != null ? Math.round(qtMedian) : null,
    qtcIntervalMs: qtc != null ? Math.round(qtc) : null,
    heartRateBpm: heartRate != null ? Math.round(heartRate) : null,
  };

  const clipped = samples.filter((v) => v <= 100 || v >= 4090).length;
  const clipPct = (clipped * 100) / samples.length;
  const rrCv = rrMs.length > 1 ? stdDev(rrMs) / mean(rrMs) : 1;

  let score = 100;
  if (clipPct > 2) score -= Math.min(35, (clipPct - 2) * 5);
  if (rPeaks.length < 4) score -= 20;
  if (prVals.length < 3 || qrsVals.length < 3 || qtVals.length < 3) score -= 25;
  if (rrCv > 0.2) score -= Math.min(15, (rrCv - 0.2) * 50);

  let minV = samples[0];
  let maxV = samples[0];
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i] < minV) minV = samples[i];
    if (samples[i] > maxV) maxV = samples[i];
  }
  if (maxV - minV < 300) score -= 20;

  score = Math.round(clamp(score, 0, 100));
  const label = score >= 85 ? "Excellent" : score >= 70 ? "Good" : score >= 50 ? "Fair" : "Poor";

  return {
    observedValues,
    standardRanges: ECG_STANDARD_RANGES,
    qualityScore: {
      score,
      label,
    },
  };
};

// @desc    Enable or disable monitor session for device and user
// @route   POST /api/ecg/monitor/session
// @access  Public
export const setMonitorSession = async (req, res) => {
  console.log(`[Monitor Session] Received request: ${JSON.stringify(req.body)}`);
  try {
    const { deviceId, userId, monitor, moniter } = req.body;

    if (!deviceId || !userId) {
      return res.status(400).json({
        success: false,
        message: "deviceId and userId are required",
      });
    }

    const enabled = normalizeMonitorFlag(monitor ?? moniter, true);
    const key = monitorKey(deviceId, userId);
    monitorSessions.set(key, { enabled, oneShot: enabled });

    // Always reset capture buffer on session trigger so next block is fresh.
    monitorBuffers.delete(key);

    return res.status(200).json({
      success: true,
      deviceId,
      userId,
      monitor: enabled,
      message: enabled
        ? `Monitor one-shot session enabled for next ${MONITOR_WINDOW_SECONDS}s window`
        : "Monitor session disabled",
    });
  } catch (error) {
    console.error(`Error setting monitor session: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

const normalizeLeadName = (leadStr) => {
  if (!leadStr) return null;
  const cleaned = String(leadStr).trim().toUpperCase().replace(/[\s_\-]/g, '');
  if (cleaned === 'L1' || cleaned === 'LEAD1' || cleaned === 'LEADI') return 'L1';
  if (cleaned === 'L2' || cleaned === 'LEAD2' || cleaned === 'LEADII') return 'L2';
  if (cleaned === 'L3' || cleaned === 'LEAD3' || cleaned === 'LEADIII') return 'L3';
  if (cleaned === 'AVR') return 'aVR';
  if (cleaned === 'AVL') return 'aVL';
  if (cleaned === 'AVF') return 'aVF';
  if (['V1', 'V2', 'V3', 'V4', 'V5', 'V6'].includes(cleaned)) return cleaned;
  return null;
};

// @desc    Store new ECG data from device
// @route   POST /api/ecg
// @access  Public
export const storeEcgData = async (req, res) => {
  try {
    const { userId, deviceId, seq, sr, lo, data, mode } = req.body;

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: "deviceId is required",
      });
    }

    if (seq === undefined || sr === undefined || lo === undefined || !Array.isArray(data)) {
      return res.status(400).json({
        success: false,
        message: "seq, sr, lo and data (array) are required for ECG data post",
      });
    }

    if (typeof seq !== "number" || typeof sr !== "number" || typeof lo !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "Invalid ECG payload types: seq and sr must be numbers, lo must be boolean",
      });
    }

    const hasNonZeroSample = data.some((sample) => Number(sample) !== 0);
    if (!hasNonZeroSample) {
      return res.status(200).json({
        success: true,
        skipped: true,
        message: "ECG data contains only zero values and was not stored",
      });
    }

    const normalizedDeviceId = String(deviceId).trim();
    const normalizedUserIdRaw = userId !== undefined && userId !== null ? String(userId).trim() : "";
    const effectiveUserId = normalizedUserIdRaw || normalizedDeviceId;
    const key = monitorKey(normalizedDeviceId, effectiveUserId);
    const nowMs = Date.now();
    const lastPostAtMs = lastEcgPostAtByKey.get(key);
    const shouldNotifyNewSession = !lastPostAtMs || nowMs - lastPostAtMs > ECG_STREAM_RECONNECT_GAP_MS;
    lastEcgPostAtByKey.set(key, nowMs);

    // Save the data to MongoDB (Existing flow)
    const ecgRecord = await EcgData.create({
      userId: effectiveUserId,
      deviceId: normalizedDeviceId,
      seq,
      sr,
      lo,
      mode: mode || undefined,
      data,
    });

    if (shouldNotifyNewSession) {
      try {
        const notificationTargetUserId = await resolveNotificationTargetUserId(effectiveUserId);
        const createdNotification = await Notification.create({
          title: `ECG Session Started`,
          notification: `Device connected successfully`,
          details: `ECG data stream started for device ${normalizedDeviceId}`,
          targetUserId: notificationTargetUserId,
        });

        emitNewNotification(createdNotification);

        // Also notify admin
        await createAdminNotification({
          title: `ECG Session Started`,
          desc: `User ${notificationTargetUserId} started a session with device ${normalizedDeviceId}`,
          type: "SYSTEM",
          category: "INFO",
          metadata: { deviceId: normalizedDeviceId, userId: notificationTargetUserId }
        });
      } catch (notificationError) {
        console.error(`Error creating ECG session notification: ${notificationError.message}`);
      }
    }

    try {
      const notificationTargetUserId = await resolveNotificationTargetUserId(effectiveUserId);

      // If a user switches to another device stream, cancel the previous device timeout
      // so it doesn't emit a false "disconnected" notification.
      const previousKey = activeStreamKeyByTargetUserId.get(notificationTargetUserId);
      if (previousKey && previousKey !== key) {
        const previousTimeout = disconnectTimeoutsByKey.get(previousKey);
        if (previousTimeout) {
          clearTimeout(previousTimeout);
          disconnectTimeoutsByKey.delete(previousKey);
        }
        lastEcgPostAtByKey.delete(previousKey);
      }

      activeStreamKeyByTargetUserId.set(notificationTargetUserId, key);

      scheduleDeviceDisconnectNotification(
        key,
        normalizedDeviceId,
        notificationTargetUserId,
      );
    } catch (scheduleError) {
      console.error(`Error scheduling ECG disconnect notification: ${scheduleError.message}`);
    }

    monitorLiveClients.forEach((client) => {
      if (client.deviceId === normalizedDeviceId && client.userId === effectiveUserId) {
        client.res.write(`data: ${JSON.stringify(ecgRecord)}\n\n`);
      }
    });

    // Monitor blocks are stored whenever monitor session is enabled for this user/device.
    const monitorSession = monitorSessions.get(key);
    if (monitorSession?.enabled && monitorSession?.oneShot) {
      const deviceBuffer = monitorBuffers.get(key) || [];
      deviceBuffer.push({
        userId: effectiveUserId,
        deviceId: normalizedDeviceId,
        seq,
        sr,
        lo,
        mode: mode || undefined,
        data: Array.isArray(data) ? data : [],
        at: new Date(),
      });

      while (deviceBuffer.length >= MONITOR_WINDOW_SECONDS) {
        const windowChunks = deviceBuffer.splice(0, MONITOR_WINDOW_SECONDS);
        const storedMonitorWindow = await storeLatestMonitorWindow({
          userId: effectiveUserId,
          deviceId: normalizedDeviceId,
          windowChunks,
        });

        try {
          const reportOwnerUserId = await resolveNotificationTargetUserId(effectiveUserId);
          const reportNotification = await Notification.create({
            title: `ECG Report Generated`,
            notification: `Monitor report generated successfully after 12 seconds`,
            details: `Monitor report ${storedMonitorWindow._id} stored successfully for device ${normalizedDeviceId}`,
            targetUserId: reportOwnerUserId,
          });

          emitNewNotification(reportNotification);

          // Also notify admin
          await createAdminNotification({
            title: `ECG Report Generated`,
            desc: `A 12s ECG report was generated for user ${reportOwnerUserId} (Device: ${normalizedDeviceId})`,
            type: "REPORT",
            category: "SUCCESS",
            metadata: { deviceId: normalizedDeviceId, userId: reportOwnerUserId, monitorId: storedMonitorWindow._id }
          });
        } catch (notificationError) {
          console.error(`Error creating monitor report notification: ${notificationError.message}`);
        }

        // One-shot behavior: stop after storing one complete 12-second block.
        monitorSessions.set(key, { enabled: false, oneShot: false });
        monitorBuffers.delete(key);
        break;
      }

      if (monitorSessions.get(key)?.enabled) {
        monitorBuffers.set(key, deviceBuffer);
      }
    }

    // --- Broadcast Live to connected SSE clients ---
    const payloadString = JSON.stringify(ecgRecord);
    liveClients.forEach(client => {
      if (client.deviceId === normalizedDeviceId) {
        client.res.write(`data: ${payloadString}\n\n`);
      }
    });

    // --- Seamless 12-Lead Background Accumulation (8s Per Lead) ---
    const currentLead = normalizeLeadName(mode) || activeLeadSessions.get(key);

    if (currentLead) {
      try {
        let activeTest = await TwelveLeadEcg.findOne({
          $or: [
            { deviceId: normalizedDeviceId, status: "collecting" },
            { userId: effectiveUserId, status: "collecting" },
          ],
        }).sort({ createdAt: -1 });

        if (!activeTest) {
          activeTest = await TwelveLeadEcg.create({
            userId: effectiveUserId,
            deviceId: normalizedDeviceId,
            sr: typeof sr === "number" ? sr : 250,
            status: "collecting",
            completedLeads: [],
            totalLeads: 0,
            leads: {},
          });
        }

        if (activeTest && activeTest.status === "collecting") {
          const sampleRate = typeof sr === "number" && sr > 0 ? sr : (activeTest.sr || 250);
          const maxTargetSamples = 8 * sampleRate; // 8 seconds of data per lead

          const validSamples = data.map((s) => Number(s) || 0);
          if (!activeTest.leads) activeTest.leads = {};

          const existingSamples = activeTest.leads[currentLead] || [];
          if (existingSamples.length < maxTargetSamples) {
            const updatedLeadSamples = [...existingSamples, ...validSamples].slice(0, maxTargetSamples);
            activeTest.leads[currentLead] = updatedLeadSamples;

            if (updatedLeadSamples.length >= maxTargetSamples && !activeTest.completedLeads.includes(currentLead)) {
              activeTest.completedLeads.push(currentLead);
            }
          }

          // Check if all 8 physical leads (L1, L2, V1, V2, V3, V4, V5, V6) have completed 8s
          const REQUIRED_PHYSICAL_LEADS = ["L1", "L2", "V1", "V2", "V3", "V4", "V5", "V6"];
          const hasAll8PhysicalLeads = REQUIRED_PHYSICAL_LEADS.every(
            (l) => Array.isArray(activeTest.leads[l]) && activeTest.leads[l].length >= maxTargetSamples
          );

          if (hasAll8PhysicalLeads) {
            // Automatically calculate derived limb leads: Lead III, aVR, aVL, aVF
            const L1_data = activeTest.leads.L1 || [];
            const L2_data = activeTest.leads.L2 || [];
            const minLen = Math.min(L1_data.length, L2_data.length);

            const L3_data = [];
            const aVR_data = [];
            const aVL_data = [];
            const aVF_data = [];

            for (let i = 0; i < minLen; i++) {
              const l1 = L1_data[i];
              const l2 = L2_data[i];

              const l3 = l2 - l1;
              const avr = -(l1 + l2) / 2;
              const avl = l1 - (l2 / 2);
              const avf = l2 - (l1 / 2);

              L3_data.push(Number(l3.toFixed(4)));
              aVR_data.push(Number(avr.toFixed(4)));
              aVL_data.push(Number(avl.toFixed(4)));
              aVF_data.push(Number(avf.toFixed(4)));
            }

            activeTest.leads.L3 = L3_data;
            activeTest.leads.aVR = aVR_data;
            activeTest.leads.aVL = aVL_data;
            activeTest.leads.aVF = aVF_data;

            ["L3", "aVR", "aVL", "aVF"].forEach((dName) => {
              if (!activeTest.completedLeads.includes(dName)) {
                activeTest.completedLeads.push(dName);
              }
            });

            activeTest.status = "completed";
            activeTest.totalLeads = 12;
            activeTest.completedAt = new Date();

            activeLeadSessions.delete(key);
          }

          activeTest.markModified("leads");
          await activeTest.save();
        }
      } catch (twelveLeadErr) {
        console.error(`Error accumulating 12-lead sample in storeEcgData: ${twelveLeadErr.message}`);
      }
    }

    res.status(201).json({
      success: true,
      data: ecgRecord,
    });
  } catch (error) {
    console.error(`Error saving ECG Data: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Monitor live stream by device and user
// @route   GET /api/ecg/monitor/live/:deviceId/:userId
// @access  Public
export const streamMonitorLiveEcg = async (req, res) => {
  const { deviceId, userId } = req.params;
  const key = monitorKey(deviceId, userId);
  const session = monitorSessions.get(key);

  if (!session?.enabled) {
    return res.status(400).json({
      success: false,
      message: "Monitor session is not enabled for this deviceId and userId",
    });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write(`data: ${JSON.stringify({ message: `Connected to monitor live stream for ${deviceId}/${userId}` })}\n\n`);

  try {
    const recentRecords = await EcgData.find({ deviceId, userId }).sort({ createdAt: -1 }).limit(30);
    if (recentRecords.length > 0) {
      recentRecords.reverse().forEach((record) => {
        res.write(`data: ${JSON.stringify(record)}\n\n`);
      });
    }
  } catch (error) {
    console.error(`Error sending initial monitor live ECG data: ${error.message}`);
  }

  const clientId = Date.now() + Math.floor(Math.random() * 1000);
  monitorLiveClients.push({ id: clientId, deviceId, userId, res });

  req.on("close", () => {
    monitorLiveClients = monitorLiveClients.filter((client) => client.id !== clientId);
  });
};

// @desc    Get stored monitor ECG block by monitor report ID
// @route   GET /api/ecg/monitor/:monitorId
// @access  Public
export const getMonitorEcgData = async (req, res) => {
  try {
    const { monitorId } = req.params;

    if (!monitorId || !mongoose.Types.ObjectId.isValid(monitorId)) {
      return res.status(400).json({
        success: false,
        message: "Valid monitorId is required",
      });
    }

    const record = await MonitorEcgData.findById(monitorId);
    const records = record ? [record] : [];
    const chronologicalData = records;

    const deviceId = record?.deviceId || null;
    const userId = record?.userId || null;

    let userDetails = null;
    let userType = null;

    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      const mainUser = await User.findById(userId).select("-password").lean();
      if (mainUser) {
        userDetails = mainUser;
        userType = "main-user";
      } else {
        const addedUser = await AddedUser.findById(userId).lean();
        if (addedUser) {
          userDetails = addedUser;
          userType = "member";
        }
      }
    }

    const latestWindow = chronologicalData.length ? chronologicalData[chronologicalData.length - 1] : null;
    const tableReport = computeMonitorEcgTable(latestWindow);

    return res.status(200).json({
      success: true,
      deviceId,
      userId,
      userType,
      userDetails,
      count: chronologicalData.length,
      tableReport,
      data: chronologicalData,
    });
  } catch (error) {
    console.error(`Error fetching monitor ECG Data: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Delete one stored monitor ECG block by monitor record ID
// @route   DELETE /api/ecg/monitor/:monitorId
// @access  Public
export const deleteMonitorEcgData = async (req, res) => {
  try {
    const { monitorId } = req.params;

    if (!monitorId) {
      return res.status(400).json({
        success: false,
        message: "monitorId is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(monitorId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid monitorId",
      });
    }

    const deletedRecord = await MonitorEcgData.findByIdAndDelete(monitorId);

    return res.status(200).json({
      success: Boolean(deletedRecord),
      monitorId,
      message: deletedRecord
        ? "Monitor ECG report deleted successfully"
        : "Monitor ECG report not found",
      data: deletedRecord || null,
    });
  } catch (error) {
    console.error(`Error deleting monitor ECG Data: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Get all monitor ECG data with full user details
// @route   GET /api/ecg/monitor/all/with-users
// @access  Public
export const getAllMonitorEcgDataWithUsers = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const mainUser = await User.findById(userId).select("-password").lean();
    const memberUsers = await AddedUser.find({ createdBy: userId }).lean();

    const memberIds = memberUsers.map((member) => String(member._id));
    const targetUserIds = [...new Set([String(userId), ...memberIds])];

    const monitorRecords = await MonitorEcgData.find({ userId: { $in: targetUserIds } })
      .sort({ createdAt: -1 })
      .limit(limit);

    const memberMap = new Map(memberUsers.map((member) => [String(member._id), member]));

    const data = monitorRecords.map((record) => ({
      ...record.toObject(),
      userDetails:
        String(record.userId) === String(userId)
          ? mainUser
          : memberMap.get(String(record.userId)) || null,
    }));

    return res.status(200).json({
      success: true,
      count: data.length,
      filter: {
        userId: userId || null,
      },
      mainUserDetails: mainUser,
      memberCount: memberUsers.length,
      data,
    });
  } catch (error) {
    console.error(`Error fetching all monitor ECG data with users: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Get members (and main user) that have monitor ECG data for a given userId
// @route   GET /api/ecg/monitor/members-with-data/:userId
// @access  Public
export const getMembersWithMonitorDataByUser = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const mainUser = mongoose.Types.ObjectId.isValid(userId)
      ? await User.findById(userId).select("-password").lean()
      : null;

    const memberUsers = mongoose.Types.ObjectId.isValid(userId)
      ? await AddedUser.find({ createdBy: userId }).lean()
      : [];

    const memberMap = new Map(memberUsers.map((member) => [String(member._id), member]));
    const targetUserIds = [String(userId), ...memberUsers.map((member) => String(member._id))];

    const grouped = await MonitorEcgData.aggregate([
      {
        $match: {
          userId: { $in: targetUserIds },
        },
      },
      {
        $sort: { createdAt: -1 },
      },
      {
        $group: {
          _id: "$userId",
          totalWindows: { $sum: 1 },
          latestRecord: { $first: "$$ROOT" },
          lastWindowAt: { $first: "$createdAt" },
        },
      },
      {
        $sort: { lastWindowAt: -1 },
      },
    ]);

    const membersWithMonitorData = grouped.map((item) => {
      const id = String(item._id);
      const isMainUser = id === String(userId);
      const details = isMainUser ? mainUser : memberMap.get(id) || null;
      const latestRecord = item.latestRecord || null;

      return {
        userId: id,
        type: isMainUser ? "main-user" : "member",
        userDetails: details,
        monitorSummary: {
          totalWindows: item.totalWindows,
          lastWindowAt: item.lastWindowAt,
          latestRecordId: latestRecord ? latestRecord._id : null,
          deviceId: latestRecord ? latestRecord.deviceId : null,
        },
        liveStreamPath:
          latestRecord && latestRecord.deviceId
            ? `/api/ecg/monitor/live/${latestRecord.deviceId}/${id}`
            : null,
      };
    });

    return res.status(200).json({
      success: true,
      ownerUserId: userId,
      count: membersWithMonitorData.length,
      data: membersWithMonitorData,
    });
  } catch (error) {
    console.error(`Error fetching members with monitor ECG data: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Get LIVE Real-Time ECG data stream using Server-Sent Events (SSE)
// @route   GET /api/ecg/live/:deviceId
// @access  Public
export const streamLiveEcg = async (req, res) => {
  const { deviceId } = req.params;

  // Set headers critical for Server-Sent Events (SSE)
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  // Send an initial connection event
  res.write(`data: ${JSON.stringify({ message: `Connected to live stream for ${deviceId}` })}\n\n`);

  try {
    // PREVENT GAP SKIPPING: Send the most recent 30 records immediately upon connection
    // If a client drops and reconnects 2+ seconds later, they instantly get the missing chunks!
    const recentRecords = await EcgData.find({ deviceId }).sort({ createdAt: -1 }).limit(30);
    if (recentRecords.length > 0) {
      const chronological = recentRecords.reverse();
      chronological.forEach(record => {
        res.write(`data: ${JSON.stringify(record)}\n\n`);
      });
    }
  } catch (error) {
    console.error(`Error sending initial live ECG data: ${error.message}`);
  }

  const clientId = Date.now();
  
  // Add this new client connection to our global array
  const newClient = {
    id: clientId,
    deviceId,
    res
  };
  liveClients.push(newClient);

  // When the client closes the connection, safely remove them from the array
  req.on('close', () => {
    console.log(`Live Stream client disconnected: ${clientId}`);
    liveClients = liveClients.filter(client => client.id !== clientId);
  });
};

// @desc    Get ECG data for a specific device
// @route   GET /api/ecg/:deviceId
// @access  Public
export const getEcgData = async (req, res) => {
  try {
    const { deviceId } = req.params;

    // Default limit to 10 records (representing ~10 seconds of data if 1 record = 1 sec)
    // You can pass ?limit=50 to get more
    const limit = parseInt(req.query.limit) || 10;

    // Fetch the most recent data for the device, sorted by desc (newest first)
    const ecgRecords = await EcgData.find({ deviceId })
      .sort({ createdAt: -1 })
      .limit(limit);

    // Reverse the array so the frontend receives the chunks chronologically (oldest to newest)
    const chronologicalData = ecgRecords.reverse();

    res.status(200).json({
      success: true,
      deviceId,
      count: chronologicalData.length,
      data: chronologicalData,
    });
  } catch (error) {
    console.error(`Error fetching ECG Data: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Get ECG data and abnormality data for a specific user
// @route   GET /api/ecg/user/:userId/all-with-abnormality
// @access  Public
export const getEcgAndAbnormalityByUserId = async (req, res) => {
  try {
    const { userId } = req.params;
    const { deviceId, startDate, endDate, limit } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const normalizedUserId = String(userId).trim();
    const normalizedDeviceId = deviceId ? String(deviceId).trim() : null;

    const ecgFilter = { userId: normalizedUserId };
    if (normalizedDeviceId) {
      ecgFilter.deviceId = normalizedDeviceId;
    }

    if (startDate || endDate) {
      ecgFilter.createdAt = {};
      if (startDate) {
        ecgFilter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        ecgFilter.createdAt.$lte = new Date(endDate);
      }
    }

    let ecgQuery = EcgData.find(ecgFilter).sort({ createdAt: -1 });
    const parsedLimit = Number.parseInt(limit, 10);
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      ecgQuery = ecgQuery.limit(parsedLimit);
    }

    const ecgRecords = await ecgQuery;
    const chronologicalEcgData = ecgRecords.reverse();

    let abnormalityData = [];
    if (mongoose.Types.ObjectId.isValid(normalizedUserId)) {
      const abnormalityFilter = {
        userId: new mongoose.Types.ObjectId(normalizedUserId),
      };

      if (normalizedDeviceId) {
        abnormalityFilter.deviceId = normalizedDeviceId;
      }

      if (startDate || endDate) {
        abnormalityFilter.date = {};
        if (startDate) {
          abnormalityFilter.date.$gte = String(startDate).slice(0, 10);
        }
        if (endDate) {
          abnormalityFilter.date.$lte = String(endDate).slice(0, 10);
        }
      }

      abnormalityData = await Abnormality.find(abnormalityFilter)
        .sort({ date: -1 })
        .lean();
    }

    const totalAbnormalities = abnormalityData.reduce(
      (sum, item) => sum + (Array.isArray(item.abnormalities) ? item.abnormalities.length : 0),
      0,
    );

    return res.status(200).json({
      success: true,
      userId: normalizedUserId,
      count: {
        ecgRecords: chronologicalEcgData.length,
        abnormalityDays: abnormalityData.length,
        totalAbnormalities,
      },
      data: {
        ecg: chronologicalEcgData,
        abnormalities: abnormalityData,
      },
    });
  } catch (error) {
    console.error(`Error fetching ECG and abnormality data by user: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Update device_result for a specific ECG chunk
// @route   PUT /api/ecg/device_result
// @access  Public
export const updateDeviceResult = async (req, res) => {
  try {
    const { deviceId, seq, recordId, device_result } = req.body;

    if (!deviceId || device_result === undefined) {
      return res.status(400).json({
        success: false,
        message: "deviceId and device_result are required",
      });
    }

    let filterObj = { deviceId, seq };
    
    // Use recordId if it is a valid 24-char ObjectId
    if (recordId && /^[0-9a-fA-F]{24}$/.test(recordId)) {
      filterObj = { _id: recordId };
    }

    const updatedRecord = await EcgData.findOneAndUpdate(
      filterObj,
      { 
        $set: { 
          deviceId, 
          seq, 
          device_result 
        },
        $setOnInsert: {
          data: [],
          sr: 360,
          lo: false,
        }
      },
      { returnDocument: 'after', upsert: true } // If the record was skipped, create it so the result isn't lost!
    );

    // --- Broadcast Live Update to connected SSE clients ---
    const payloadString = JSON.stringify({
      type: 'device_result_update',
      data: updatedRecord
    });
    
    liveClients.forEach(client => {
      if (client.deviceId === deviceId) {
        client.res.write(`data: ${payloadString}\n\n`);
      }
    });

    res.status(200).json({
      success: true,
      message: "device_result successfully updated",
      data: updatedRecord,
    });
  } catch (error) {
    console.error(`Error updating device_result: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Admin API - Get all monitor reports with user and abnormality details
// @route   GET /api/ecg/admin/all-reports
// @access  Admin Only
export const getAdminAllReports = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const { userId, deviceId, startDate, endDate } = req.query;
    
    const skip = (page - 1) * limit;
    const filter = {};

    // Apply optional filters
    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      filter.userId = new mongoose.Types.ObjectId(userId);
    }

    if (deviceId) {
      filter.deviceId = String(deviceId).trim();
    }

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.createdAt.$lte = new Date(endDate);
      }
    }

    // Get total count for pagination info
    const totalRecords = await MonitorEcgData.countDocuments(filter);
    const totalPages = Math.ceil(totalRecords / limit);

    // Fetch monitor records with pagination
    const monitorRecords = await MonitorEcgData.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Fetch all unique users for efficient lookup
    const userIds = [...new Set(monitorRecords.map(r => String(r.userId)))];
    const allMainUsers = await User.find({ _id: { $in: userIds } })
      .select("-password")
      .lean();
    const allAddedUsers = await AddedUser.find({ _id: { $in: userIds } })
      .select("-password")
      .lean();

    const mainUserMap = new Map(allMainUsers.map(u => [String(u._id), u]));
    const addedUserMap = new Map(allAddedUsers.map(u => [String(u._id), u]));

    // Enrich monitor records with user details and abnormalities
    const enrichedData = monitorRecords.map((record) => {
      const userId = String(record.userId);
      let userDetails = mainUserMap.get(userId) || addedUserMap.get(userId) || null;
      let userType = mainUserMap.has(userId) ? "main_user" : "added_user";

      // If added user, also fetch main user info
      let mainUserInfo = null;
      if (addedUserMap.has(userId)) {
        const addedUser = addedUserMap.get(userId);
        mainUserInfo = mainUserMap.get(String(addedUser.createdBy)) || null;
      }

      return {
        _id: record._id,
        monitorId: record._id,
        deviceId: record.deviceId,
        userId: record.userId,
        userType,
        userDetails,
        mainUserInfo: userType === "added_user" ? mainUserInfo : null,
        
        // Monitor ECG Data
        ecgData: {
          fromSeq: record.fromSeq,
          toSeq: record.toSeq,
          sampleCount: record.sampleCount,
          sr: record.sr,
          durationSeconds: record.durationSeconds,
          lo: record.lo,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
          dataPoints: Array.isArray(record.data) ? record.data.length : 0,
        },

        // Abnormalities
        abnormalities: {
          total: Array.isArray(record.abnormalities) ? record.abnormalities.length : 0,
          data: Array.isArray(record.abnormalities) ? record.abnormalities : [],
          summary: Array.isArray(record.abnormalities) 
            ? record.abnormalities.reduce((acc, abn) => {
                const key = abn.abnormalityName || "unknown";
                acc[key] = (acc[key] || 0) + 1;
                return acc;
              }, {})
            : {},
        },

        // Timestamps
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    });

    return res.status(200).json({
      success: true,
      pagination: {
        currentPage: page,
        totalPages,
        limit,
        totalRecords,
        recordsOnThisPage: enrichedData.length,
      },
      filter: {
        userId: userId || null,
        deviceId: deviceId || null,
        startDate: startDate || null,
        endDate: endDate || null,
      },
      statistics: {
        totalMonitorSessions: totalRecords,
        averageAbnormalities: enrichedData.length > 0
          ? (enrichedData.reduce((sum, r) => sum + r.abnormalities.total, 0) / enrichedData.length).toFixed(2)
          : 0,
        sessionsReturned: enrichedData.length,
      },
      data: enrichedData,
    });
  } catch (error) {
    console.error(`Error fetching admin all reports: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Admin API - Get one monitor report full details by monitorId
// @route   GET /api/ecg/admin/all-reports/:monitorId
// @access  Admin Only
export const getAdminReportDetails = async (req, res) => {
  try {
    const { monitorId } = req.params;

    if (!monitorId || !mongoose.Types.ObjectId.isValid(monitorId)) {
      return res.status(400).json({
        success: false,
        message: "Valid monitorId is required",
      });
    }

    const record = await MonitorEcgData.findById(monitorId).lean();
    if (!record) {
      return res.status(404).json({
        success: false,
        message: "Monitor report not found",
      });
    }

    const normalizedUserId = String(record.userId);
    const mainUser = await User.findById(normalizedUserId).select("-password").lean();
    const addedUser = mainUser ? null : await AddedUser.findById(normalizedUserId).lean();
    const mainUserInfo = addedUser?.createdBy
      ? await User.findById(String(addedUser.createdBy)).select("-password").lean()
      : null;

    const userType = mainUser ? "main_user" : addedUser ? "added_user" : "unknown";
    const userDetails = mainUser || addedUser || null;

    return res.status(200).json({
      success: true,
      data: {
        _id: record._id,
        monitorId: record._id,
        deviceId: record.deviceId,
        userId: record.userId,
        userType,
        userDetails,
        mainUserInfo: userType === "added_user" ? mainUserInfo : null,
        ecgData: {
          fromSeq: record.fromSeq,
          toSeq: record.toSeq,
          sampleCount: record.sampleCount,
          sr: record.sr,
          durationSeconds: record.durationSeconds,
          lo: record.lo,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
          data: Array.isArray(record.data) ? record.data : [],
          dataPoints: Array.isArray(record.data) ? record.data.length : 0,
        },
        abnormalities: {
          total: Array.isArray(record.abnormalities) ? record.abnormalities.length : 0,
          data: Array.isArray(record.abnormalities) ? record.abnormalities : [],
          summary: Array.isArray(record.abnormalities)
            ? record.abnormalities.reduce((acc, abn) => {
                const key = abn.abnormalityName || "unknown";
                acc[key] = (acc[key] || 0) + 1;
                return acc;
              }, {})
            : {},
        },
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    });
  } catch (error) {
    console.error(`Error fetching admin report details: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Get ECG data list for a specific user grouped by date
// @route   GET /api/ecg/user/:userId/list-by-date
// @access  Public
export const getEcgListByUserDateWise = async (req, res) => {
  try {
    const { userId } = req.params;
    const { deviceId, startDate, endDate, limit } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const normalizedUserId = String(userId).trim();

    let userType = "unknown";
    let relation = null;
    let userDetails = null;
    let ownerDetails = null;

    if (mongoose.Types.ObjectId.isValid(normalizedUserId)) {
      const mainUser = await User.findById(normalizedUserId).select("-password").lean();

      if (mainUser) {
        userType = "main_user";
        relation = "self";
        userDetails = mainUser;
      } else {
        const addedUser = await AddedUser.findById(normalizedUserId).lean();
        if (addedUser) {
          userType = "member";
          relation = addedUser.relation || null;
          userDetails = addedUser;

          if (addedUser.createdBy && mongoose.Types.ObjectId.isValid(String(addedUser.createdBy))) {
            ownerDetails = await User.findById(String(addedUser.createdBy)).select("-password").lean();
          }
        }
      }
    }

    const ecgFilter = { userId: normalizedUserId };

    if (deviceId) {
      ecgFilter.deviceId = String(deviceId).trim();
    }

    if (startDate || endDate) {
      ecgFilter.createdAt = {};
      if (startDate) {
        ecgFilter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        ecgFilter.createdAt.$lte = new Date(endDate);
      }
    }

    // FINAL FIX: Remove ALL $sort stages from MongoDB entirely.
    // Atlas M0/M2/M5 has a hard 32MB sort limit and blocks allowDiskUse.
    // $group does NOT need a prior $sort — we sort the results in JavaScript instead.
    const pipeline = [
      { $match: ecgFilter },
      // Strip the large `data` array and pre-compute IST date/time strings
      // so $group can reference them directly without any $sort.
      {
        $project: {
          istDate: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: { $add: ["$createdAt", 19800000] },
              timezone: "UTC",
            },
          },
          istTime: {
            $dateToString: {
              format: "%H:%M:%S",
              date: { $add: ["$createdAt", 19800000] },
              timezone: "UTC",
            },
          },
          sr: 1,
          dataLength: { $cond: [{ $isArray: "$data" }, { $size: "$data" }, 0] },
        },
      },
      // Group by pre-computed IST date — no $sort needed before $group
      {
        $group: {
          _id: "$istDate",
          recordCount: { $sum: 1 },
          records: {
            $push: {
              time: "$istTime",
              dataLength: "$dataLength",
              sr: "$sr",
            },
          },
        },
      },
      // NO $sort in MongoDB at all — all ordering done in JavaScript below
    ];

    const grouped = await EcgData.aggregate(pipeline);

    // All ordering and limiting done in JavaScript — zero MongoDB sort operations
    const calculateDuration = (dataLength, sr) => {
      const safeSr = Number.isFinite(sr) && sr > 0 ? sr : 0;
      const seconds = safeSr > 0 ? dataLength / safeSr : 0;
      return {
        minutes: Number((seconds / 60).toFixed(2)),
        hours: Number((seconds / 3600).toFixed(2)),
      };
    };

    // Sort date buckets newest-first, then optionally limit number of date groups
    let groupedByDate = grouped
      .map((bucket) => {
        // Sort records within each day newest-first by time string (HH:MM:SS, lexicographic)
        const records = bucket.records
          .sort((a, b) => (a.time > b.time ? -1 : 1))
          .map((r) => ({
            time: r.time,
            duration: calculateDuration(r.dataLength, r.sr),
          }));
        const totalMinutes = records.reduce((s, r) => s + r.duration.minutes, 0);
        const totalHours = records.reduce((s, r) => s + r.duration.hours, 0);
        return {
          date: bucket._id,
          recordCount: bucket.recordCount,
          totalDuration: {
            minutes: Number(totalMinutes.toFixed(2)),
            hours: Number(totalHours.toFixed(2)),
          },
          records,
        };
      })
      .sort((a, b) => (a.date > b.date ? -1 : 1)); // newest date first

    // Apply limit as number-of-date-groups if provided
    const parsedLimit = Number.parseInt(limit, 10);
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      groupedByDate = groupedByDate.slice(0, parsedLimit);
    }

    const totalRecords = groupedByDate.reduce((s, d) => s + d.recordCount, 0);
    const overallMinutes = groupedByDate.reduce((s, d) => s + d.totalDuration.minutes, 0);
    const overallHours = groupedByDate.reduce((s, d) => s + d.totalDuration.hours, 0);

    return res.status(200).json({
      success: true,
      userId: normalizedUserId,
      user: {
        userType,
        relation,
        details: userDetails,
        ownerDetails,
      },
      filter: {
        deviceId: deviceId || null,
        startDate: startDate || null,
        endDate: endDate || null,
      },
      summary: {
        totalRecords,
        totalDays: groupedByDate.length,
        totalDuration: {
          minutes: Number(overallMinutes.toFixed(2)),
          hours: Number(overallHours.toFixed(2)),
        },
      },
      data: groupedByDate,
    });
  } catch (error) {
    console.error(`Error fetching ECG list by user date wise: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Get all currently active live users/devices (streaming within the gap window)
// @route   GET /api/ecg/live-status/active
// @access  Public
export const getActiveLiveUsers = async (req, res) => {
  try {
    const nowMs = Date.now();
    const activeStreams = [];
    
    // Iterate over active streams
    for (const [key, lastPostAtMs] of lastEcgPostAtByKey.entries()) {
      // Check if still active within the gap
      if (nowMs - lastPostAtMs < ECG_STREAM_RECONNECT_GAP_MS) {
        const [deviceId, userId] = key.split('::');
        
        // Count how many clients are currently watching this stream
        const watcherCount = liveClients.filter(c => c.deviceId === deviceId).length;
        const monitorWatcherCount = monitorLiveClients.filter(c => c.deviceId === deviceId && c.userId === userId).length;
        
        activeStreams.push({
          deviceId,
          userId,
          lastActive: new Date(lastPostAtMs),
          watchers: watcherCount + monitorWatcherCount,
          liveStreamPath: `/api/ecg/live/${deviceId}`,
          monitorLiveStreamPath: `/api/ecg/monitor/live/${deviceId}/${userId}`
        });
      }
    }

    // Fetch basic user details to make the response more informative
    const enrichedStreams = await getEnrichedActiveStreams();

    return res.status(200).json({
      success: true,
      count: enrichedStreams.length,
      data: enrichedStreams
    });
  } catch (error) {
    console.error(`Error fetching active live users: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message
    });
  }
};

// Helper function for fetching enriched active streams
const getEnrichedActiveStreams = async () => {
  const nowMs = Date.now();
  const activeStreams = [];
  
  for (const [key, lastPostAtMs] of lastEcgPostAtByKey.entries()) {
    if (nowMs - lastPostAtMs < ECG_STREAM_RECONNECT_GAP_MS) {
      const [deviceId, userId] = key.split('::');
      const watcherCount = liveClients.filter(c => c.deviceId === deviceId).length;
      const monitorWatcherCount = monitorLiveClients.filter(c => c.deviceId === deviceId && c.userId === userId).length;
      
      activeStreams.push({
        deviceId,
        userId,
        lastActive: new Date(lastPostAtMs),
        watchers: watcherCount + monitorWatcherCount,
        liveStreamPath: `/api/ecg/live/${deviceId}`,
        monitorLiveStreamPath: `/api/ecg/monitor/live/${deviceId}/${userId}`
      });
    }
  }

  const enrichedStreams = await Promise.all(activeStreams.map(async (stream) => {
    let userDetails = null;
    let userType = "unknown";
    
    if (stream.userId && mongoose.Types.ObjectId.isValid(stream.userId)) {
      const mainUser = await User.findById(stream.userId).select('full_name email phone').lean();
      if (mainUser) {
        userDetails = mainUser;
        userType = "main_user";
      } else {
        const addedUser = await AddedUser.findById(stream.userId).select('full_name relation age gender').lean();
        if (addedUser) {
          userDetails = addedUser;
          userType = "member";
        }
      }
    }
    
    return {
      ...stream,
      userType,
      userDetails
    };
  }));

  return enrichedStreams;
};

// @desc    Stream currently active live users/devices (SSE)
// @route   GET /api/ecg/live-status/stream
// @access  Public
export const streamActiveLiveUsers = async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendActiveUsers = async () => {
    try {
      const enrichedStreams = await getEnrichedActiveStreams();
      res.write(`data: ${JSON.stringify({ success: true, count: enrichedStreams.length, data: enrichedStreams })}\n\n`);
    } catch (err) {
      console.error(`Error sending active users SSE: ${err.message}`);
    }
  };

  // Send immediately on connection
  await sendActiveUsers();

  // Then send every 5 seconds
  const intervalId = setInterval(sendActiveUsers, 5000);

  req.on('close', () => {
    clearInterval(intervalId);
  });
};

// ==========================================
// 12 LEADS ECG FLOW CONTROLLERS
// ==========================================


// @desc    Calculate missing derived leads and generate full 12-lead ECG report
// @route   POST /api/ecg/generate-12-lead
// @access  Public
export const generateTwelveLeadEcg = async (req, res) => {
  try {
    const { deviceId, userId, testId } = req.body;

    if (!deviceId && !userId && !testId) {
      return res.status(400).json({
        success: false,
        message: "deviceId, userId, or testId is required",
      });
    }

    let testDoc = null;
    if (testId && mongoose.Types.ObjectId.isValid(testId)) {
      testDoc = await TwelveLeadEcg.findById(testId);
    } else {
      const query = {};
      if (deviceId) query.deviceId = String(deviceId).trim();
      if (userId) query.userId = String(userId).trim();

      testDoc = await TwelveLeadEcg.findOne(query).sort({ createdAt: -1 });
    }

    if (!testDoc) {
      return res.status(404).json({
        success: false,
        message: "No 12-lead ECG recording found for this device/user",
      });
    }

    const L1_data = testDoc.leads.L1 || [];
    const L2_data = testDoc.leads.L2 || [];

    if (L1_data.length === 0 || L2_data.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Both Lead I (L1) and Lead II (L2) data are required to generate derived leads",
      });
    }

    const minLen = Math.min(L1_data.length, L2_data.length);
    const L3_data = [];
    const aVR_data = [];
    const aVL_data = [];
    const aVF_data = [];

    for (let i = 0; i < minLen; i++) {
      const l1 = L1_data[i];
      const l2 = L2_data[i];

      const l3 = l2 - l1;
      const avr = -(l1 + l2) / 2;
      const avl = l1 - (l2 / 2);
      const avf = l2 - (l1 / 2);

      L3_data.push(Number(l3.toFixed(4)));
      aVR_data.push(Number(avr.toFixed(4)));
      aVL_data.push(Number(avl.toFixed(4)));
      aVF_data.push(Number(avf.toFixed(4)));
    }

    testDoc.leads.L3 = L3_data;
    testDoc.leads.aVR = aVR_data;
    testDoc.leads.aVL = aVL_data;
    testDoc.leads.aVF = aVF_data;

    const allDerived = ["L3", "aVR", "aVL", "aVF"];
    allDerived.forEach((dName) => {
      if (!testDoc.completedLeads.includes(dName)) {
        testDoc.completedLeads.push(dName);
      }
    });

    testDoc.status = "completed";
    testDoc.totalLeads = 12;
    testDoc.completedAt = new Date();

    testDoc.markModified("leads");
    await testDoc.save();

    // Clear active lead session map for this device/user
    if (testDoc.deviceId && testDoc.userId) {
      const key = monitorKey(testDoc.deviceId, testDoc.userId);
      activeLeadSessions.delete(key);
    }

    return res.status(200).json({
      success: true,
      completed: true,
      totalLeads: 12,
      testId: testDoc._id,
      leads: {
        L1: testDoc.leads.L1,
        L2: testDoc.leads.L2,
        L3: testDoc.leads.L3,
        aVR: testDoc.leads.aVR,
        aVL: testDoc.leads.aVL,
        aVF: testDoc.leads.aVF,
        V1: testDoc.leads.V1,
        V2: testDoc.leads.V2,
        V3: testDoc.leads.V3,
        V4: testDoc.leads.V4,
        V5: testDoc.leads.V5,
        V6: testDoc.leads.V6,
      },
    });
  } catch (error) {
    console.error(`Error generating 12-lead ECG: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Set active lead for recording session (e.g., L1, L2, V1..V6)
// @route   POST /api/ecg/lead-session
// @access  Public
export const setLeadSession = async (req, res) => {
  try {
    const { deviceId, userId, lead, reset } = req.body;

    if (!deviceId || !userId) {
      return res.status(400).json({
        success: false,
        message: "deviceId and userId are required",
      });
    }

    const key = monitorKey(deviceId, userId);

    if (reset) {
      activeLeadSessions.delete(key);
      await TwelveLeadEcg.deleteMany({ deviceId, userId, status: "collecting" });
      return res.status(200).json({
        success: true,
        message: "12-lead ECG recording session reset successfully",
      });
    }

    const normalizedLead = normalizeLeadName(lead);
    if (!normalizedLead) {
      return res.status(400).json({
        success: false,
        message: `Invalid lead name '${lead}'. Allowed: L1, L2, V1, V2, V3, V4, V5, V6`,
      });
    }

    activeLeadSessions.set(key, normalizedLead);

    // Ensure active collecting 12-lead document exists
    let testDoc = await TwelveLeadEcg.findOne({
      deviceId: String(deviceId).trim(),
      userId: String(userId).trim(),
      status: "collecting",
    }).sort({ createdAt: -1 });

    if (!testDoc) {
      testDoc = await TwelveLeadEcg.create({
        userId: String(userId).trim(),
        deviceId: String(deviceId).trim(),
        status: "collecting",
        completedLeads: [],
        totalLeads: 0,
        leads: {},
      });
    }

    return res.status(200).json({
      success: true,
      deviceId,
      userId,
      activeLead: normalizedLead,
      testId: testDoc._id,
      message: `Active lead set to ${normalizedLead}. Incoming /api/ecg data will be saved for ${normalizedLead}.`,
    });
  } catch (error) {
    console.error(`Error setting lead session: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

