import mongoose from "mongoose";

function getISTTime() {
  const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC +5:30
  const now = new Date();
  const istTime = new Date(now.getTime() + istOffset);
  return istTime;
}

const planSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },

    category: {
      type: String,
      enum: ["Meal Plan", "Meditation", "Exercises"],
    },

    description: {
      type: String,
      required: true,
    },

    duration_in_day: {
      type: String,
      default: "",
    },

    schedule: [
      {
        weekNumber: {
          type: String,
        },
        week_description: {
          type: String,
        },
      },
    ],

    planType: {
      type: String,
      enum: ["basic", "premium", "clinical_lite", "clinical"],
      default: "basic",
      index: true,
    },

    iconType: {
      type: String,
      enum: ["heart", "crown", "sparkle", "custom"],
      default: "heart",
    },

    price: {
      type: Number,
      default: 0,
      min: 0,
    },

    currency: {
      type: String,
      default: "INR",
      trim: true,
      uppercase: true,
    },

    billingCycle: {
      type: String,
      enum: ["monthly", "yearly", "lifetime"],
      default: "monthly",
    },

    consultancyCount: {
      type: Number,
      min: 0,
    },

    features: {
      type: [String],
      default: [],
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: {
      currentTime: () => getISTTime(),
    },
  },
);

const Plan = mongoose.model("Plan", planSchema);

export default Plan;
