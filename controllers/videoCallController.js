import VideoCall from "../models/videoCallModel.js";
import Consultancy from "../models/consultancyModel.js";
import PlanPurchase from "../models/planPurchaseModel.js";
import Notification from "../models/notificationModel.js";
import { emitNewNotification, emitVideoCallUpdate } from "../services/notificationSocket.js";
import { addConsultancyUsageInfo } from "./plan.Controller.js";

// ─── Constants ───────────────────────────────────────────────────────────────
// const SESSION_DURATION_MS = 15 * 60 * 1000; // 15 minutes (Moved to dynamic calculation)
const WARNING_BEFORE_END_MS = 120000; // Default 2 min, will be capped dynamically
const EXTENSION_TRIGGER_BEFORE_END_MS = 30000; // trigger extension 30s before end (increased from 20s for better UX)
const EXTENSION_RESPONSE_TIMEOUT_MS = 90 * 1000; // 90 s to respond to extension

// ─── In-memory timer registry ─────────────────────────────────────────────────
const activeTimers = new Map();

// ─── Helper: clear all timers for a room ─────────────────────────────────────
function clearRoomTimers(roomId) {
  const timers = activeTimers.get(roomId);
  if (!timers) return;
  clearTimeout(timers.warningTimer);
  clearTimeout(timers.endTimer);
  clearTimeout(timers.extensionTimer);
  clearTimeout(timers.extensionTriggerTimer);
  activeTimers.delete(roomId);
}

// ─── Helper: fetch the patient's active plan purchase ────────────────────────
async function fetchActivePlanPurchase(userId) {
  return PlanPurchase.findOne({
    userId,
    isCurrent: true,
    purchaseStatus: { $in: ["pending", "active"] },
  })
    .populate(
      "planId",
      "title planType iconType price currency billingCycle features consultancyCount isActive",
    )
    .sort({ createdAt: -1 });
}

async function getRemainingConsultancyCredits(purchase) {
  if (!purchase) return 0;

  const totalLimit = Number(
    purchase?.planSnapshot?.consultancyCount ??
      purchase?.planId?.consultancyCount ??
      0,
  );
  if (totalLimit <= 0) return 0;

  const usedCount = await Consultancy.countDocuments({
    userId: purchase.userId,
    planPurchaseId: purchase._id,
    bookingStatus: { $in: ["pending", "booked"] },
    paymentStatus: { $ne: "failed" },
  });

  return Math.max(0, totalLimit - usedCount);
}

async function createVideoCallNotification({ userId, title, notification, details = "" }) {
  const createdNotification = await Notification.create({
    title,
    notification,
    details,
    targetUserId: String(userId),
  });

  emitNewNotification(createdNotification);
  return createdNotification;
}

// ─── Helper: are both doctor AND user currently in the room? ─────────────────
function bothParticipantsActive(videoCall) {
  const ACTIVE_THRESHOLD_MS = 15000; // 15 seconds
  const now = Date.now();

  const doctor = videoCall.participants.find(
    (p) => p.userModel === "Doctor" && p.joinedAt && !p.leftAt,
  );
  const user = videoCall.participants.find(
    (p) => p.userModel === "User" && p.joinedAt && !p.leftAt,
  );

  if (!doctor || !user) return false;

  const doctorActive =
    doctor.lastSeenAt &&
    now - new Date(doctor.lastSeenAt).getTime() < ACTIVE_THRESHOLD_MS;
  const userActive =
    user.lastSeenAt &&
    now - new Date(user.lastSeenAt).getTime() < ACTIVE_THRESHOLD_MS;

  return doctorActive && userActive;
}

// ─── Core: Start the 15-min session timer ────────────────────────────────────
async function startSessionTimer(roomId) {
  clearRoomTimers(roomId);

  const videoCall = await VideoCall.findOne({ roomId }).populate(
    "consultancyId",
  );
  if (!videoCall || videoCall.status !== "ongoing") return;

  const sessionDurationMs =
    (videoCall.consultancyId?.consultationDurationMinutes || 1) * 60 * 1000;

  let currentSession = videoCall.sessions[videoCall.sessions.length - 1];
  let remainingMs = sessionDurationMs;

  // Closed sessions must not be resumed.
  if (currentSession?.endedAt) {
    currentSession = null;
  }

  // If there's an ongoing session that hasn't expired, resume it
  if (currentSession && !currentSession.endedAt) {
    const elapsed = Date.now() - new Date(currentSession.startedAt).getTime();
    remainingMs = Math.max(0, sessionDurationMs - elapsed);
    if (remainingMs <= 0) {
      // Actually expired, should have been handled, but let's be safe
      currentSession.endedAt = new Date();
      currentSession = null;
    }
  }

  if (!currentSession) {
    // Start a brand new session slot
    videoCall.sessions.push({
      sessionIndex: videoCall.sessions.length,
      startedAt: new Date(),
    });
    remainingMs = sessionDurationMs;
  }

  videoCall.timerActive = true;
  videoCall.sessionCount = videoCall.sessions.length;
  await videoCall.save();

  const sessionEntryIdx = videoCall.sessions.length - 1;
  const currentRemaining = remainingMs;

  // ── Warning: 2 min before expiry ──────────────────────────────────────────
  const warningTimer = setTimeout(async () => {
    try {
      const vc = await VideoCall.findOne({ roomId });
      if (!vc || vc.status !== "ongoing" || !vc.sessions[sessionEntryIdx])
        return;

      vc.sessions[sessionEntryIdx].warningSentAt = new Date();
      await vc.save();

      const dynamicWarningMs = Math.min(WARNING_BEFORE_END_MS, sessionDurationMs * 0.2);
      const warningPayload = {
        event: "session_warning",
        roomId,
        sessionIndex: sessionEntryIdx,
        message: `⚠️ Only a short time remaining in your session.`,
        remainingMs: dynamicWarningMs,
      };
      emitVideoCallUpdate(vc.userId, "User", warningPayload);
      emitVideoCallUpdate(vc.doctorId, "Doctor", warningPayload);
    } catch (err) {
      console.error("[SessionTimer] Warning emit error:", err.message);
    }
  }, Math.max(0, currentRemaining - Math.min(WARNING_BEFORE_END_MS, sessionDurationMs * 0.2)));

  // ── Session end: trigger extension check ──────────────────────────────────
  const endTimer = setTimeout(async () => {
    try {
      await handleSessionExpiry(roomId, sessionEntryIdx);
    } catch (err) {
      console.error("[SessionTimer] Session expiry error:", err.message);
    }
  }, currentRemaining);

  // ── Extension Prompt: 20s before expiry ──────────────────────────────────
  const extensionTriggerTimer = setTimeout(
    async () => {
      try {
        const vc = await VideoCall.findOne({ roomId }).populate(
          "consultancyId",
        );
        if (!vc || vc.status !== "ongoing" || !vc.sessions[sessionEntryIdx])
          return;

        const purchase = await fetchActivePlanPurchase(vc.userId);
        const consultancyCount = await getRemainingConsultancyCredits(purchase);

        if (purchase && consultancyCount >= 1) {
          await createExtensionRequest(
            vc,
            sessionEntryIdx,
            purchase,
            consultancyCount,
          );
        }
      } catch (err) {
        console.error("[SessionTimer] Extension trigger error:", err.message);
      }
    },
    Math.max(0, currentRemaining - EXTENSION_TRIGGER_BEFORE_END_MS),
  );

  activeTimers.set(roomId, {
    warningTimer,
    endTimer,
    extensionTimer: null,
    extensionTriggerTimer,
  });
}

// ─── Core: What happens when the 15 min runs out ─────────────────────────────
async function handleSessionExpiry(roomId, sessionIdx) {
  clearRoomTimers(roomId);

  const videoCall = await VideoCall.findOne({ roomId });
  if (
    !videoCall ||
    videoCall.status !== "ongoing" ||
    !videoCall.sessions[sessionIdx]
  )
    return;

  videoCall.sessions[sessionIdx].endedAt = new Date();
  videoCall.timerActive = false;
  await videoCall.save();

  const purchase = await fetchActivePlanPurchase(videoCall.userId);
  const consultancyCount = await getRemainingConsultancyCredits(purchase);

  if (!purchase || consultancyCount < 1) {
    await endCallDueNoCredits(videoCall);
    return;
  }

  await createExtensionRequest(
    videoCall,
    sessionIdx,
    purchase,
    consultancyCount,
    { forceEmit: true },
  );
}

// ─── End call because consultancyCount exhausted ─────────────────────────────
async function endCallDueNoCredits(videoCall) {
  const now = new Date();
  videoCall.endedAt = now;
  videoCall.status = "completed";
  if (videoCall.startedAt) {
    videoCall.duration = Math.round((now - videoCall.startedAt) / 1000);
  }
  await videoCall.save();

  const payload = {
    event: "session_ended",
    roomId: videoCall.roomId,
    reason: "no_credits",
    message: "Session ended. No consultancy credits remaining.",
    videoCall,
  };
  emitVideoCallUpdate(videoCall.userId, "User", payload);
  emitVideoCallUpdate(videoCall.doctorId, "Doctor", payload);
}

// ─── Create a new extension request ──────────────────────────────────────────
async function createExtensionRequest(
  videoCall,
  sessionIdx,
  purchase,
  consultancyCount,
  options = {},
) {
  const existing = videoCall.sessions?.[sessionIdx]?.extensionRequest;
  const forceEmit = Boolean(options.forceEmit);

  if (existing && existing.status === "pending" && !forceEmit) {
    return;
  }

  // Stop running session timers while waiting for extension decision.
  clearRoomTimers(videoCall.roomId);

  if (!existing || existing.status !== "pending") {
    videoCall.sessions[sessionIdx].extensionRequest = {
      requestedAt: new Date(),
      status: "pending",
      doctorResponse: "pending",
      userResponse: "pending",
    };
    await videoCall.save();
  }

  const payload = {
    event: "extension_requested",
    consultancyCreditsRemaining: consultancyCount,
    sessionIndex: sessionIdx,
    sessionDurationMs:
      (videoCall.consultancyId?.consultationDurationMinutes || 1) * 60 * 1000,
    message: `Your session is about to end. You have ${consultancyCount} credit(s) remaining. Accept to extend?`,
    responseDeadlineMs: EXTENSION_RESPONSE_TIMEOUT_MS,
  };

  // ── Step 1: Only notify the User first ──────────────────────────────────
  emitVideoCallUpdate(videoCall.userId, "User", payload);

  const extensionTimer = setTimeout(async () => {
    try {
      const vc = await VideoCall.findOne({ roomId: videoCall.roomId });
      if (!vc || !vc.sessions[sessionIdx]) return;

      const ext = vc.sessions[sessionIdx].extensionRequest;
      if (!ext || ext.status !== "pending") return;

      ext.status = "expired";
      ext.resolvedAt = new Date();
      await vc.save();

          // Emit a guaranteed end event before calling the cleanup function so
          // clients get an immediate signal even if the cleanup throws.
          try {
            const payload = {
              event: "session_ended",
              roomId: vc.roomId,
              reason: "extension_rejected_or_timeout",
              message: "Session ended. Extension was not accepted.",
              videoCall: vc,
            };
            emitVideoCallUpdate(vc.userId, "User", payload);
            emitVideoCallUpdate(vc.doctorId, "Doctor", payload);
          } catch (emitErr) {
            console.error("[ExtensionTimer] emit error:", emitErr.message);
          }

          await endCallDueToTimeout(vc);
    } catch (err) {
      console.error("[ExtensionTimer] Timeout error:", err.message);
    }
  }, EXTENSION_RESPONSE_TIMEOUT_MS);

  activeTimers.set(videoCall.roomId, {
    warningTimer: null,
    endTimer: null,
    extensionTimer,
    extensionTriggerTimer: null,
  });
}

// ─── End call because extension timed out or was rejected ────────────────────
async function endCallDueToTimeout(videoCall) {
  try {
    clearRoomTimers(videoCall.roomId);
    if (videoCall.status === "completed") return;

    const now = new Date();
    videoCall.endedAt = now;
    videoCall.status = "completed";
    if (videoCall.startedAt) {
      videoCall.duration = Math.round((now - videoCall.startedAt) / 1000);
    }
    await videoCall.save();

    const payload = {
      event: "session_ended",
      roomId: videoCall.roomId,
      reason: "extension_rejected_or_timeout",
      message: "Session ended. Extension was not accepted.",
      videoCall,
    };
    emitVideoCallUpdate(videoCall.userId, "User", payload);
    emitVideoCallUpdate(videoCall.doctorId, "Doctor", payload);
  } catch (err) {
    console.error("[endCallDueToTimeout] error:", err.message);
    // As a last resort, still attempt to notify via socket with minimal payload
    try {
      emitVideoCallUpdate(videoCall.userId, "User", {
        event: "session_ended",
        roomId: videoCall.roomId,
        reason: "extension_rejected_or_timeout",
        message: "Session ended.",
      });
      emitVideoCallUpdate(videoCall.doctorId, "Doctor", {
        event: "session_ended",
        roomId: videoCall.roomId,
        reason: "extension_rejected_or_timeout",
        message: "Session ended.",
      });
    } catch (emitErr) {
      console.error("[endCallDueToTimeout] fallback emit failed:", emitErr.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ROUTE HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

export const initiateCall = async (req, res) => {
  try {
    const { consultancyId } = req.body;
    if (!consultancyId) {
      return res
        .status(400)
        .json({ success: false, message: "Consultancy ID is required" });
    }

    const consultancy = await Consultancy.findById(consultancyId);
    if (!consultancy) {
      return res
        .status(404)
        .json({ success: false, message: "Consultancy not found" });
    }

    if (String(consultancy.doctorId) !== String(req.doctor._id)) {
      return res.status(403).json({
        success: false,
        message: "You can initiate only your assigned consultancy",
      });
    }

    if (consultancy.doctorAssignmentStatus !== "approved") {
      return res.status(403).json({
        success: false,
        message: "Doctor must accept the consultancy before joining the video call",
      });
    }

    let videoCall = await VideoCall.findOne({ roomId: consultancyId });
    if (videoCall) {
      if (videoCall.status === "completed") {
        videoCall.status = "initiated";
        videoCall.startedAt = null;
        videoCall.endedAt = null;
        videoCall.duration = 0;
        videoCall.timerActive = false;
        videoCall.sessions = [];
        videoCall.sessionCount = 0;
        await videoCall.save();
      }
    } else {
      videoCall = await VideoCall.create({
        consultancyId,
        doctorId: consultancy.doctorId,
        userId: consultancy.userId,
        roomId: consultancyId,
        status: "initiated",
        meetingLink: `/doctor/video-consultation/${consultancyId}`,
      });
    }

    let patientCurrentPlan = null;
    try {
      const currentPurchase = await fetchActivePlanPurchase(consultancy.userId);
      if (currentPurchase) {
        patientCurrentPlan = await addConsultancyUsageInfo(currentPurchase);
      }
    } catch (planError) {
      console.error("Plan fetch error:", planError.message);
    }

    emitVideoCallUpdate(consultancy.userId, "User", {
      event: "call_initiated",
      status: videoCall.status,
      roomId: videoCall.roomId,
      message: "Doctor has initiated a video call",
      videoCall,
    });

    const updatedVC = await VideoCall.findById(videoCall._id).populate(
      "consultancyId",
    );

    let syncInfo = null;
    if (updatedVC.timerActive) {
      const last = updatedVC.sessions[updatedVC.sessions.length - 1];
      if (last?.startedAt && !last.endedAt) {
        const duration =
          (updatedVC.consultancyId?.consultationDurationMinutes || 1) *
          60 *
          1000;
        const elapsed = Date.now() - new Date(last.startedAt).getTime();
        syncInfo = {
          sessionDurationMs: duration,
          remainingMs: Math.max(0, duration - elapsed),
          sessionIndex: updatedVC.sessions.length - 1,
        };
      }
    }

    res.status(200).json({
      success: true,
      message: "Call initiated",
      videoCall: updatedVC,
      patientCurrentPlan,
      syncInfo,
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Server Error", error: error.message });
  }
};

export const handleCallEvent = async (req, res) => {
  try {
    const { roomId, event, userId, userType } = req.body;
    const videoCall = await VideoCall.findOne({ roomId });
    if (!videoCall)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });

    const now = new Date();
    if (event === "join") {
      if (userType === "Doctor") {
        const consultancy = await Consultancy.findById(videoCall.consultancyId).lean();
        if (!consultancy) {
          return res.status(404).json({
            success: false,
            message: "Consultancy not found",
          });
        }

        if (String(consultancy.doctorId) !== String(userId)) {
          return res.status(403).json({
            success: false,
            message: "Only the assigned doctor can join this video call",
          });
        }

        if (consultancy.doctorAssignmentStatus !== "approved") {
          return res.status(403).json({
            success: false,
            message: "Doctor must accept the consultancy before joining",
          });
        }
      }

      const idx = videoCall.participants.findIndex(
        (p) => p.userId.toString() === userId && p.userModel === userType,
      );
      if (idx > -1) {
        videoCall.participants[idx].joinedAt = now;
        videoCall.participants[idx].leftAt = null;
        videoCall.participants[idx].lastSeenAt = now;
      } else {
        videoCall.participants.push({
          userId,
          userModel: userType,
          joinedAt: now,
          leftAt: null,
          lastSeenAt: now,
        });
      }

      // ── Doctor reporting patient is also here (from Zego onUserJoin) ────────
      if (userType === "Doctor" && req.body.isPatientPresent) {
        const pIdx = videoCall.participants.findIndex(
          (p) =>
            p.userModel === "User" &&
            p.userId.toString() === videoCall.userId.toString(),
        );
        if (pIdx > -1) {
          videoCall.participants[pIdx].joinedAt = now;
          videoCall.participants[pIdx].leftAt = null;
          videoCall.participants[pIdx].lastSeenAt = now;
        } else {
          videoCall.participants.push({
            userId: videoCall.userId,
            userModel: "User",
            joinedAt: now,
            leftAt: null,
            lastSeenAt: now,
          });
        }
      }

      if (!videoCall.startedAt) {
        videoCall.startedAt = now;
        videoCall.status = "ongoing";
      }

      await videoCall.save();

      if (userType === "Doctor") {
        emitVideoCallUpdate(videoCall.userId, "User", {
          event: "participant_joined",
          roomId: videoCall.roomId,
          message: "Doctor has joined",
          videoCall,
        });
      } else {
        emitVideoCallUpdate(videoCall.doctorId, "Doctor", {
          event: "participant_joined",
          roomId: videoCall.roomId,
          message: "Patient has joined",
          videoCall,
        });
      }

      const refreshed = await VideoCall.findOne({ roomId }).populate(
        "consultancyId",
      );
      const sessionDurationMs =
        (refreshed.consultancyId?.consultationDurationMinutes || 1) *
        60 *
        1000;

      if (bothParticipantsActive(refreshed)) {
        if (!refreshed.timerActive) {
          // ── Both just joined for first time → Start fresh timer ──────
          await startSessionTimer(roomId);
          const finalVC = await VideoCall.findOne({ roomId });
          const payload = {
            event: "session_started",
            roomId,
            sessionIndex: finalVC.sessions.length - 1,
            sessionDurationMs: sessionDurationMs,
            remainingMs: sessionDurationMs, // ← explicit remaining
            message: `${sessionDurationMs / 60000}-minute session started.`,
            videoCall: finalVC,
          };
          emitVideoCallUpdate(finalVC.userId, "User", payload);
          emitVideoCallUpdate(finalVC.doctorId, "Doctor", payload);
        } else {
          // ── Timer already running → sync the participant who just (re-)joined ─
          const currentSession =
            refreshed.sessions[refreshed.sessions.length - 1];
          if (
            currentSession &&
            currentSession.startedAt &&
            !currentSession.endedAt
          ) {
            const elapsed =
              Date.now() - new Date(currentSession.startedAt).getTime();
            const remaining = Math.max(0, sessionDurationMs - elapsed);
            if (remaining > 0) {
              const syncPayload = {
                event: "session_started",
                roomId,
                sessionIndex: refreshed.sessions.length - 1,
                sessionDurationMs: sessionDurationMs,
                remainingMs: remaining,
                message: "Session in progress. Timer synchronised.",
                videoCall: refreshed,
              };
              // Only send to the person who just joined — other side already has timer
              emitVideoCallUpdate(userId, userType, syncPayload);
            }
          }
        }
      }
    } else if (event === "leave") {
      const idx = videoCall.participants.findIndex(
        (p) => p.userId.toString() === userId && p.userModel === userType,
      );
      if (idx > -1) videoCall.participants[idx].leftAt = now;
      await videoCall.save();

      if (videoCall.timerActive) {
        clearRoomTimers(roomId);
        videoCall.timerActive = false;
        await videoCall.save();
      }
    }
    const finalRefreshed = await VideoCall.findOne({ roomId }).populate(
      "consultancyId",
    );

    // ── If timer is active, include sync info in the response directly ──────
    let syncInfo = null;
    if (finalRefreshed.timerActive) {
      const last = finalRefreshed.sessions[finalRefreshed.sessions.length - 1];
      if (last?.startedAt && !last.endedAt) {
        const duration =
          (finalRefreshed.consultancyId?.consultationDurationMinutes || 1) *
          60 *
          1000;
        const elapsed = Date.now() - new Date(last.startedAt).getTime();
        syncInfo = {
          sessionDurationMs: duration,
          remainingMs: Math.max(0, duration - elapsed),
          sessionIndex: finalRefreshed.sessions.length - 1,
        };
      }
    }

    res
      .status(200)
      .json({ success: true, videoCall: finalRefreshed, syncInfo });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Server Error", error: error.message });
  }
};

export const requestExtension = async (req, res) => {
  try {
    const { roomId } = req.body;
    const videoCall = await VideoCall.findOne({ roomId });
    if (!videoCall || videoCall.status !== "ongoing")
      return res
        .status(400)
        .json({ success: false, message: "Call not active" });

    const sessionIdx = videoCall.sessions.length - 1;
    if (sessionIdx < 0)
      return res
        .status(400)
        .json({ success: false, message: "No active session to extend" });

    const ext = videoCall.sessions[sessionIdx].extensionRequest;
    if (ext && ext.status === "pending")
      return res
        .status(200)
        .json({ success: true, message: "Already pending", videoCall });

    const purchase = await fetchActivePlanPurchase(videoCall.userId);
    const count = await getRemainingConsultancyCredits(purchase);
    if (!purchase || count < 1)
      return res
        .status(403)
        .json({ success: false, message: "No credits", count: 0 });

    await createExtensionRequest(videoCall, sessionIdx, purchase, count);
    const updated = await VideoCall.findOne({ roomId });
    res.status(200).json({
      success: true,
      message: "Extension requested",
      videoCall: updated,
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Server Error", error: error.message });
  }
};

export const respondToExtension = async (req, res) => {
  try {
    const { roomId, sessionIndex, response, userType } = req.body;
    if (!roomId || sessionIndex === undefined || !response || !userType)
      return res
        .status(400)
        .json({ success: false, message: "Missing fields" });

    const videoCall = await VideoCall.findOne({ roomId }).populate(
      "consultancyId",
    );
    if (!videoCall || !videoCall.sessions[sessionIndex])
      return res.status(404).json({ success: false, message: "Not found" });

    const ext = videoCall.sessions[sessionIndex].extensionRequest;
    if (!ext || ext.status !== "pending")
      return res.status(400).json({ success: false, message: "Not pending" });

    // Ignore duplicate responses from the same side.
    if (userType === "Doctor" && ext.doctorResponse !== "pending") {
      return res.status(200).json({
        success: true,
        message: "Doctor response already recorded",
        videoCall,
      });
    }
    if (userType !== "Doctor" && ext.userResponse !== "pending") {
      return res.status(200).json({
        success: true,
        message: "User response already recorded",
        videoCall,
      });
    }

    if (userType === "Doctor") ext.doctorResponse = response;
    else ext.userResponse = response;

    // ── If User accepts, now show it to the Doctor ───────────────────────────
    if (
      userType === "User" &&
      response === "accepted" &&
      ext.doctorResponse === "pending"
    ) {
      // SAVE FIRST to ensure consistency for polling/socket
      await videoCall.save();

      const purchase = await fetchActivePlanPurchase(videoCall.userId);
      const consultancyCount = await getRemainingConsultancyCredits(purchase);

      const payload = {
        event: "extension_requested",
        roomId: videoCall.roomId,
        consultancyCreditsRemaining: consultancyCount,
        sessionIndex: Number(sessionIndex),
        sessionDurationMs:
          (videoCall.consultancyId?.consultationDurationMinutes || 1) *
          60 *
          1000,
        message:
          "The patient has requested a session extension. Do you accept?",
        responseDeadlineMs: EXTENSION_RESPONSE_TIMEOUT_MS,
      };
      emitVideoCallUpdate(videoCall.doctorId, "Doctor", payload);

      await createVideoCallNotification({
        userId: videoCall.doctorId,
        title: "Extension Requested",
        notification: "Patient accepted the extension request",
        details: `Room: ${videoCall.roomId}`,
      });
    }

    if (response === "rejected") {
      ext.status = "rejected";
      ext.resolvedAt = new Date();
      await videoCall.save();
      clearRoomTimers(roomId);
      // Emit explicit close event so clients close the popup immediately
      try {
        const closePayload = {
          event: "extension_request_closed",
          roomId: videoCall.roomId,
          sessionIndex: sessionIndex,
          status: "rejected",
          message: "Extension request rejected",
          videoCall,
        };
        emitVideoCallUpdate(videoCall.userId, "User", closePayload);
        emitVideoCallUpdate(videoCall.doctorId, "Doctor", closePayload);

        // Then emit session_ended so clients perform full cleanup immediately
        emitVideoCallUpdate(videoCall.userId, "User", {
          event: "session_ended",
          roomId: videoCall.roomId,
          reason: "extension_rejected",
          message: "Session ended. Extension was rejected.",
          videoCall,
        });
        emitVideoCallUpdate(videoCall.doctorId, "Doctor", {
          event: "session_ended",
          roomId: videoCall.roomId,
          reason: "extension_rejected",
          message: "Session ended. Extension was rejected.",
          videoCall,
        });
      } catch (emitErr) {
        console.error("[respondToExtension] emit error:", emitErr.message);
      }

      await endCallDueToTimeout(videoCall);
      return res.status(200).json({
        success: true,
        message: "Rejected",
        videoCall: await VideoCall.findOne({ roomId }),
      });
    }

    if (ext.doctorResponse === "accepted" && ext.userResponse === "accepted") {
      ext.status = "accepted";
      ext.resolvedAt = new Date();

      // Close current session explicitly before starting the next slot.
      if (!videoCall.sessions[sessionIndex].endedAt) {
        videoCall.sessions[sessionIndex].endedAt = new Date();
      }

      await videoCall.save();
      clearRoomTimers(roomId);

      // Remaining credits are derived from consultancy bookings, so no stored counter is updated here.

      await startSessionTimer(roomId);
      const finalVC = await VideoCall.findOne({ roomId }).populate(
        "consultancyId",
      );
      const sessionDurationMs =
        (finalVC.consultancyId?.consultationDurationMinutes || 15) * 60 * 1000;

      // Compute remainingMs for client sync using the newly started session entry
      const lastSession = finalVC.sessions[finalVC.sessions.length - 1];
      let remainingMs = sessionDurationMs;
      let sessionStartedAt = null;
      if (lastSession && lastSession.startedAt) {
        sessionStartedAt = new Date(lastSession.startedAt).toISOString();
        const elapsed = Date.now() - new Date(lastSession.startedAt).getTime();
        remainingMs = Math.max(0, sessionDurationMs - elapsed);
      }

      const payload = {
        event: "extension_accepted",
        roomId: videoCall.roomId,
        sessionIndex: finalVC.sessions.length - 1,
        sessionDurationMs,
        remainingMs,
        sessionStartedAt,
        message: "Session extended successfully",
        videoCall: finalVC,
      };

      const closePayload = {
        event: "extension_request_closed",
        roomId: videoCall.roomId,
        sessionIndex: finalVC.sessions.length - 1,
        status: "accepted",
        message: "Extension request resolved",
        videoCall: finalVC,
      };

      emitVideoCallUpdate(finalVC.userId, "User", closePayload);
      emitVideoCallUpdate(finalVC.doctorId, "Doctor", closePayload);
      emitVideoCallUpdate(finalVC.userId, "User", payload);
      emitVideoCallUpdate(finalVC.doctorId, "Doctor", payload);

      await createVideoCallNotification({
        userId: finalVC.userId,
        title: "Extension Accepted",
        notification: "Your consultation extension has started",
        details: `Room: ${finalVC.roomId}`,
      });

      return res
        .status(200)
        .json({ success: true, message: "Extended", videoCall: finalVC });
    }

    await videoCall.save();
    res
      .status(200)
      .json({ success: true, message: "Response recorded", videoCall });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Server Error", error: error.message });
  }
};

export const completeCall = async (req, res) => {
  try {
    const { roomId } = req.body;
    const videoCall = await VideoCall.findOne({ roomId });
    if (!videoCall)
      return res.status(404).json({ success: false, message: "Not found" });

    clearRoomTimers(roomId);
    const now = new Date();
    videoCall.endedAt = now;
    videoCall.status = "completed";
    videoCall.timerActive = false;
    if (videoCall.startedAt)
      videoCall.duration = Math.round((now - videoCall.startedAt) / 1000);
    await videoCall.save();

    const payload = {
      event: "call_ended",
      roomId,
      message: "Ended",
      videoCall,
    };
    emitVideoCallUpdate(videoCall.userId, "User", payload);
    emitVideoCallUpdate(videoCall.doctorId, "Doctor", payload);

    res.status(200).json({ success: true, message: "Completed", videoCall });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Server Error", error: error.message });
  }
};

export const getCallStatus = async (req, res) => {
  try {
    const videoCall = await VideoCall.findOne({
      roomId: req.params.roomId,
    }).populate("consultancyId");
    if (!videoCall)
      return res.status(404).json({ success: false, message: "Not found" });

    // ── Update presence heartbeat on every poll ─────────────────────────────
    // Note: In a real app, user identity would come from req.user
    // For now, we'll try to find the participant based on common identity if possible
    // Or just trust that if they are polling, they are present.
    // If the poll includes userId/userType, we use that.
    const { userId, userType } = req.query;
    if (userId && userType) {
      const idx = videoCall.participants.findIndex(
        (p) => p.userId.toString() === userId && p.userModel === userType,
      );
      if (idx > -1) {
        videoCall.participants[idx].lastSeenAt = new Date();
        await videoCall.save();
      }
    }

    res.status(200).json({ success: true, videoCall });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Server Error", error: error.message });
  }
};
