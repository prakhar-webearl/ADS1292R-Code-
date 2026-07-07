import Abnormality from "../models/abnormalityModel.js";
import EcgData from "../models/EcgData.js";
import User from "../models/userModel.js";
import AddedUser from "../models/userAddModel.js";
import mongoose from "mongoose";

function getISTTime() {
    const istOffset = 5.5 * 60 * 60 * 1000;
    const now = new Date();
    const istTime = new Date(now.getTime() + istOffset);
    return istTime;
}

function getTodayDateString() {
    const today = getISTTime();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

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

const computeEcgTable = ({ data, sr }) => {
  const samples = Array.isArray(data) ? data : [];
  const safeSr = Number.isFinite(sr) && sr > 0 ? sr : 360;

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

  const rPeaks = detectRPeaks(samples, safeSr);
  const rrMs = [];
  for (let i = 0; i < rPeaks.length - 1; i += 1) {
    rrMs.push(((rPeaks[i + 1] - rPeaks[i]) / safeSr) * 1000);
  }

  const prVals = [];
  const qrsVals = [];
  const qtVals = [];

  for (let i = 1; i < rPeaks.length - 1; i += 1) {
    const r = rPeaks[i];

    const pStart = Math.max(0, r - Math.floor(0.22 * safeSr));
    const pEnd = Math.max(pStart + 1, r - Math.floor(0.06 * safeSr));
    const qStart = Math.max(0, r - Math.floor(0.04 * safeSr));
    const qEnd = Math.max(qStart + 1, r);
    const sStart = r;
    const sEnd = Math.min(samples.length, r + Math.floor(0.06 * safeSr));
    const tStart = Math.min(samples.length - 1, r + Math.floor(0.12 * safeSr));
    const tEnd = Math.min(samples.length, r + Math.floor(0.42 * safeSr));

    if (pEnd <= pStart || qEnd <= qStart || sEnd <= sStart || tEnd <= tStart) {
      continue;
    }

    const pPeak = argMaxInRange(samples, pStart, pEnd);
    const qIdx = argMinInRange(samples, qStart, qEnd);
    const sIdx = argMinInRange(samples, sStart, sEnd);
    const tPeak = argMaxInRange(samples, tStart, tEnd);

    const pOnset = Math.max(0, pPeak - Math.floor(0.04 * safeSr));
    const qrsOnset = Math.max(0, qIdx - Math.floor(0.02 * safeSr));
    const tOffset = Math.min(samples.length - 1, tPeak + Math.floor(0.08 * safeSr));

    const pr = ((qrsOnset - pOnset) / safeSr) * 1000;
    const qrs = ((sIdx - qrsOnset) / safeSr) * 1000;
    const qt = ((tOffset - qrsOnset) / safeSr) * 1000;

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

// @desc    Store abnormality data for a user
// @route   POST /api/abnormality
// @access  Public
export const storeAbnormality = async (req, res) => {
  try {
    const {
      userId,
      deviceId,
      abnormalityName,
      severity,
      confidence,
      bpm,
      data,
      additionalData,
    } = req.body;

    if (!userId || !deviceId || !abnormalityName || !severity) {
      return res.status(400).json({
        success: false,
        message:
          "userId, deviceId, abnormalityName, and severity are required",
      });
    }

    const today = getTodayDateString();

    // Find or create a document for this user on this date
    const abnormalityDoc = await Abnormality.findOneAndUpdate(
      { userId, date: today },
      {
        $push: {
          abnormalities: {
            timestamp: getISTTime(),
            abnormalityName,
            severity,
            confidence: confidence || 0,
            bpm: bpm || 0,
            data: Array.isArray(data) ? data : [],
            additionalData: additionalData || {},
          },
        },
        $set: {
          deviceId,
          lastUpdated: getISTTime(),
        },
        $inc: {
          totalAbnormalities: 1,
        },
      },
      { upsert: true, returnDocument: 'after', runValidators: true }
    );

    console.log(
      `[ABNORMALITY] Stored for user=${userId}, device=${deviceId}, abnormality=${abnormalityName}`
    );

    res.status(200).json({
      success: true,
      message: "Abnormality stored successfully",
      data: abnormalityDoc,
    });
  } catch (error) {
    console.error(`Error storing abnormality: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Get abnormalities for a specific user (today)
// @route   GET /api/abnormality/user/:userId
// @access  Public
export const getAbnormalitiesForToday = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const today = getTodayDateString();

    const abnormalityData = await Abnormality.findOne({
      userId,
      date: today,
    });

    if (!abnormalityData) {
      return res.status(200).json({
        success: true,
        message: "No abnormalities recorded today",
        data: null,
        count: 0,
      });
    }

    res.status(200).json({
      success: true,
      message: "Abnormalities retrieved successfully",
      data: abnormalityData,
      count: abnormalityData.abnormalities.length,
    });
  } catch (error) {
    console.error(`Error fetching abnormalities: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Get abnormalities for a specific user on a specific date
// @route   GET /api/abnormality/user/:userId/date/:date
// @access  Public
export const getAbnormalitiesByDate = async (req, res) => {
  try {
    const { userId, date } = req.params;

    if (!userId || !date) {
      return res.status(400).json({
        success: false,
        message: "userId and date (YYYY-MM-DD format) are required",
      });
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format. Use YYYY-MM-DD",
      });
    }

    const abnormalityData = await Abnormality.findOne({
      userId,
      date,
    });

    if (!abnormalityData) {
      return res.status(200).json({
        success: true,
        message: "No abnormalities recorded on this date",
        data: null,
        count: 0,
      });
    }

    res.status(200).json({
      success: true,
      message: "Abnormalities retrieved successfully",
      data: abnormalityData,
      count: abnormalityData.abnormalities.length,
    });
  } catch (error) {
    console.error(`Error fetching abnormalities by date: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Get abnormalities for a user within a date range
// @route   GET /api/abnormality/user/:userId/range?startDate=2026-04-01&endDate=2026-04-30
// @access  Public
export const getAbnormalitiesDateRange = async (req, res) => {
  try {
    const { userId } = req.params;
    const { startDate, endDate } = req.query;

    if (!userId || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message:
          "userId, startDate, and endDate query parameters (YYYY-MM-DD) are required",
      });
    }

    const abnormalityData = await Abnormality.find(
      {
        userId,
        date: { $gte: startDate, $lte: endDate },
      },
      null,
      { sort: { date: -1 } }
    );

    res.status(200).json({
      success: true,
      message: "Abnormalities retrieved successfully",
      data: abnormalityData,
      count: abnormalityData.length,
      totalRecords: abnormalityData.reduce(
        (sum, doc) => sum + doc.abnormalities.length,
        0
      ),
    });
  } catch (error) {
    console.error(
      `Error fetching abnormalities by date range: ${error.message}`
    );
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Get critical abnormalities only
// @route   GET /api/abnormality/user/:userId/critical
// @access  Public
export const getCriticalAbnormalities = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const abnormalityData = await Abnormality.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      { $sort: { date: -1 } },
      {
        $project: {
          date: 1,
          deviceId: 1,
          critical_abnormalities: {
            $filter: {
              input: "$abnormalities",
              as: "abn",
              cond: { $eq: ["$$abn.severity", "CRITICAL"] },
            },
          },
          totalCritical: {
            $size: {
              $filter: {
                input: "$abnormalities",
                as: "abn",
                cond: { $eq: ["$$abn.severity", "CRITICAL"] },
              },
            },
          },
        },
      },
      { $match: { totalCritical: { $gt: 0 } } },
    ]);

    res.status(200).json({
      success: true,
      message: "Critical abnormalities retrieved successfully",
      data: abnormalityData,
      count: abnormalityData.length,
    });
  } catch (error) {
    console.error(
      `Error fetching critical abnormalities: ${error.message}`
    );
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Delete abnormality data for a specific date
// @route   DELETE /api/abnormality/user/:userId/date/:date
// @access  Public
export const deleteAbnormalitiesByDate = async (req, res) => {
  try {
    const { userId, date } = req.params;

    if (!userId || !date) {
      return res.status(400).json({
        success: false,
        message: "userId and date (YYYY-MM-DD format) are required",
      });
    }

    const result = await Abnormality.deleteOne({
      userId,
      date,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "No abnormality record found for this user and date",
      });
    }

    res.status(200).json({
      success: true,
      message: "Abnormality record deleted successfully",
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error(`Error deleting abnormalities: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Get abnormality and ECG data for a specific date and user
// @route   GET /api/abnormality/user/:userId/date/:date/details
// @access  Public
export const getAbnormalityAndEcgByUserAndDate = async (req, res) => {
  try {
    const { userId, date } = req.params;
    const { deviceId } = req.query;

    if (!userId || !date) {
      return res.status(400).json({
        success: false,
        message: "userId and date (YYYY-MM-DD format) are required",
      });
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({
        success: false,
        message: "Date must be in YYYY-MM-DD format",
      });
    }

    const normalizedUserId = String(userId).trim();
    const normalizedDeviceId = deviceId ? String(deviceId).trim() : null;

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

    // Parse the date to get start and end timestamps (IST)
    const [year, month, day] = date.split("-").map(Number);
    const startUtc = new Date(Date.UTC(year, month - 1, day) - 5.5 * 60 * 60 * 1000);
    const endUtc = new Date(Date.UTC(year, month - 1, day + 1) - 5.5 * 60 * 60 * 1000);

    // Fetch abnormality data for this date
    let abnormalityFilter = {
      date: date,
    };

    if (mongoose.Types.ObjectId.isValid(normalizedUserId)) {
      abnormalityFilter.userId = new mongoose.Types.ObjectId(normalizedUserId);
    } else {
      abnormalityFilter.userId = normalizedUserId;
    }

    if (normalizedDeviceId) {
      abnormalityFilter.deviceId = normalizedDeviceId;
    }

    const abnormalityData = await Abnormality.findOne(abnormalityFilter).lean();

    // Fetch ECG data for this date
    const ecgFilter = {
      userId: normalizedUserId,
      createdAt: {
        $gte: startUtc,
        $lt: endUtc,
      },
    };

    if (normalizedDeviceId) {
      ecgFilter.deviceId = normalizedDeviceId;
    }

    const ecgRecords = await EcgData.find(ecgFilter).sort({ createdAt: 1 }).lean();

    // Format helper functions
    const formatIstTime = (value) => {
      const dateObj = value ? new Date(value) : null;
      if (!dateObj || Number.isNaN(dateObj.getTime())) return null;

      const istDate = new Date(dateObj.getTime() + 5.5 * 60 * 60 * 1000);
      return `${String(istDate.getUTCHours()).padStart(2, "0")}:${String(istDate.getUTCMinutes()).padStart(2, "0")}:${String(istDate.getUTCSeconds()).padStart(2, "0")}`;
    };

    const formatIstDateTime = (value) => {
      const dateObj = value ? new Date(value) : null;
      if (!dateObj || Number.isNaN(dateObj.getTime())) return null;

      const istDate = new Date(dateObj.getTime() + 5.5 * 60 * 60 * 1000);
      const year = istDate.getUTCFullYear();
      const month = String(istDate.getUTCMonth() + 1).padStart(2, "0");
      const dayValue = String(istDate.getUTCDate()).padStart(2, "0");
      const hour = String(istDate.getUTCHours()).padStart(2, "0");
      const minute = String(istDate.getUTCMinutes()).padStart(2, "0");
      const second = String(istDate.getUTCSeconds()).padStart(2, "0");

      return `${year}-${month}-${dayValue} ${hour}:${minute}:${second}`;
    };

    const calculateDuration = (samples, sr) => {
      const sampleCount = Array.isArray(samples) ? samples.length : 0;
      const safeSr = Number.isFinite(sr) && sr > 0 ? sr : 0;
      const seconds = safeSr > 0 ? sampleCount / safeSr : 0;

      return {
        minutes: Number((seconds / 60).toFixed(2)),
        hours: Number((seconds / 3600).toFixed(2)),
      };
    };

    // Keep full ECG records for the date and add helper display fields.
    const formattedEcgRecords = ecgRecords.map((record) => ({
      ...record,
      ecgId: String(record._id),
      createdAtIst: formatIstDateTime(record.createdAt),
      time: formatIstTime(record.createdAt),
      sampleCount: Array.isArray(record.data) ? record.data.length : 0,
      duration: calculateDuration(record.data, record.sr),
    }));

    const mergedDayEcgSamples = formattedEcgRecords.flatMap((record) =>
      Array.isArray(record.data) ? record.data : []
    );
    const baseSr = formattedEcgRecords.length && Number.isFinite(formattedEcgRecords[0].sr)
      ? formattedEcgRecords[0].sr
      : 360;
    const tableReport = computeEcgTable({ data: mergedDayEcgSamples, sr: baseSr });

    // For each abnormality, attach ECG data from 2 seconds before to 2 seconds after timestamp.
    const TWO_SECONDS_MS = 2 * 1000;
    const formattedAbnormalities = abnormalityData
      ? (abnormalityData.abnormalities || []).map((abn) => {
          const abnormalityAt = abn?.timestamp ? new Date(abn.timestamp) : null;
          const hasValidTimestamp = abnormalityAt && !Number.isNaN(abnormalityAt.getTime());

          const windowStart = hasValidTimestamp
            ? new Date(abnormalityAt.getTime() - TWO_SECONDS_MS)
            : null;
          const windowEnd = hasValidTimestamp
            ? new Date(abnormalityAt.getTime() + TWO_SECONDS_MS)
            : null;

          const matchedEcgRecords = hasValidTimestamp
            ? formattedEcgRecords.filter((ecg) => {
                const ecgAt = ecg?.createdAt ? new Date(ecg.createdAt) : null;
                if (!ecgAt || Number.isNaN(ecgAt.getTime())) return false;
                return ecgAt >= windowStart && ecgAt <= windowEnd;
              })
            : [];

          const matchedSamples = matchedEcgRecords.flatMap((ecg) =>
            Array.isArray(ecg.data) ? ecg.data : []
          );

          return {
            abnormalityName: abn.abnormalityName,
            severity: abn.severity,
            confidence: abn.confidence,
            bpm: abn.bpm,
            timestamp: abn.timestamp,
            createdAtIst: formatIstDateTime(abn.timestamp),
            time: formatIstTime(abn.timestamp),
            ecgWindow: abn.ecgWindow || null,
            additionalData: abn.additionalData || {},
            ecgMatchedByTime: {
              windowSeconds: 2,
              from: windowStart,
              to: windowEnd,
              fromIst: formatIstDateTime(windowStart),
              toIst: formatIstDateTime(windowEnd),
              matchedRecordCount: matchedEcgRecords.length,
              matchedSampleCount: matchedSamples.length,
              matchedRecords: matchedEcgRecords,
              matchedSamples,
            },
          };
        })
      : [];

    return res.status(200).json({
      success: true,
      date: date,
      userId: normalizedUserId,
      filter: {
        deviceId: normalizedDeviceId || null,
      },
      summary: {
        ecgRecordCount: formattedEcgRecords.length,
        abnormalityCount: formattedAbnormalities.length,
      },
      tableReport,
      user: {
        userType,
        relation,
        details: userDetails,
        ownerDetails,
      },
      data: {
        ecgRecords: formattedEcgRecords,
        abnormalities: formattedAbnormalities,
      },
    });
  } catch (error) {
    console.error(`Error fetching abnormality and ECG data by date: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};
