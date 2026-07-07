import mongoose from "mongoose";

function getISTTime() {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  return new Date(now.getTime() + istOffset);
}

const videoCallSchema = new mongoose.Schema(
  {
    consultancyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Consultancy",
      required: true,
      index: true,
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Doctor",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    roomId: {
      type: String,
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ["initiated", "ongoing", "completed", "missed", "failed"],
      default: "initiated",
    },
    callType: {
      type: String,
      enum: ["video", "audio"],
      default: "video",
    },
    startedAt: {
      type: Date,
      default: null,
    },
    endedAt: {
      type: Date,
      default: null,
    },
    duration: {
      type: Number, // In seconds
      default: 0,
    },
    participants: [
      {
        userModel: { type: String, enum: ["User", "Doctor"] },
        userId: { type: mongoose.Schema.Types.ObjectId },
        joinedAt: { type: Date },
        leftAt: { type: Date },
        lastSeenAt: { type: Date, default: null },
      },
    ],
    recordingUrl: {
      type: String,
      default: "",
    },
    meetingLink: {
      type: String,
    },

    // ─── Session-timer tracking ──────────────────────────────────────────────
    // Whether the 15-min backend timer is actively running
    timerActive: {
      type: Boolean,
      default: false,
    },
    // Array to track each 15-minute session slot
    sessions: [
      {
        sessionIndex: { type: Number },
        startedAt: { type: Date },
        endedAt: { type: Date, default: null },
        warningSentAt: { type: Date, default: null },
        extensionRequest: {
          requestedAt: { type: Date, default: null },
          // "pending" | "accepted" | "rejected" | "expired"
          status: {
            type: String,
            enum: ["none", "pending", "accepted", "rejected", "expired"],
            default: "none",
          },
          doctorResponse: {
            type: String,
            enum: ["pending", "accepted", "rejected"],
            default: "pending",
          },
          userResponse: {
            type: String,
            enum: ["pending", "accepted", "rejected"],
            default: "pending",
          },
          resolvedAt: { type: Date, default: null },
        },
      },
    ],
    // Total number of sessions used/requested
    sessionCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: {
      currentTime: () => getISTTime(),
    },
  }
);

videoCallSchema.index({ status: 1 });
videoCallSchema.index({ createdAt: -1 });

const VideoCall = mongoose.model("VideoCall", videoCallSchema);

export default VideoCall;
