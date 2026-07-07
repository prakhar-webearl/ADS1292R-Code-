import mongoose from "mongoose";

function getISTTime() {
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC +5:30
    const now = new Date();
    const istTime = new Date(now.getTime() + istOffset);
    return istTime;
}

const abnormalitySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Please provide a user ID"],
    },

    deviceId: {
      type: String,
      required: [true, "Please provide a device ID"],
    },

    // Date stored as YYYY-MM-DD format to ensure one document per user per day
    date: {
      type: String, // Format: "2026-04-06"
      required: true,
    },

    // Array of abnormality records detected throughout the day
    abnormalities: [
      {
        timestamp: {
          type: Date,
          default: getISTTime,
        },
        abnormalityName: {
          type: String,
          required: true,
          // Examples: "Atrial Fibrillation", "Sinus Tachycardia", "Ventricular Fibrillation", etc.
        },
        severity: {
          type: String,
          enum: ["CRITICAL", "WARNING", "INFO"],
          required: true,
        },
        confidence: {
          type: Number,
          min: 0,
          max: 1,
          default: 0,
        },
        bpm: {
          type: Number,
          default: 0,
        },
        data: {
          type: [Number],
          default: [],
        },
        additionalData: {
          type: mongoose.Schema.Types.Mixed,
          default: {},
        },
      },
    ],

    // Metadata
    totalAbnormalities: {
      type: Number,
      default: 0,
    },

    lastUpdated: {
      type: Date,
      default: getISTTime,
    },

    createdAt: {
      type: Date,
      default: getISTTime,
    },
  },
  {
    timestamps: false,
  }
);

// Index for efficient querying
abnormalitySchema.index({ userId: 1, date: 1 }, { unique: true });
abnormalitySchema.index({ userId: 1, createdAt: -1 });
abnormalitySchema.index({ deviceId: 1 });

export default mongoose.model("Abnormality", abnormalitySchema);
