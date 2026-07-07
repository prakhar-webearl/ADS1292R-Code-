import mongoose from "mongoose";

function getISTTime() {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  return new Date(now.getTime() + istOffset);
}

const planPurchaseSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Plan",
      required: true,
    },
    planSnapshot: {
      title: {
        type: String,
        default: "",
      },
      status: {
        type: String,
        default: "Basic",
      },
      price: {
        type: Number,
        default: 0,
      },
      currency: {
        type: String,
        default: "INR",
      },
      billingCycle: {
        type: String,
        default: "monthly",
      },
      consultancyCount: {
        type: Number,
        default: 0,
      },
      features: {
        type: [String],
        default: [],
      },
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: "INR",
      trim: true,
      uppercase: true,
    },
    paymentMethod: {
      type: String,
      enum: ["none", "razorpay", "upi", "card", "cash", "other"],
      default: "none",
    },
    razorpayOrderId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    razorpayPaymentId: {
      type: String,
      default: "",
      trim: true,
    },
    razorpaySignature: {
      type: String,
      default: "",
      trim: true,
    },
    paymentVerifiedAt: {
      type: Date,
      default: null,
    },
    transactionId: {
      type: String,
      default: "",
      trim: true,
    },
    purchaseStatus: {
      type: String,
      enum: ["pending", "active", "expired", "cancelled", "failed"],
      default: "pending",
    },
    isCurrent: {
      type: Boolean,
      default: false,
    },
    startsAt: {
      type: Date,
      default: () => getISTTime(),
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    orderExpiresAt: {
      type: Date,
      default: null,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: {
      currentTime: () => getISTTime(),
    },
  },
);

planPurchaseSchema.index({ userId: 1, createdAt: -1 });
planPurchaseSchema.index({ userId: 1, isCurrent: 1 });

const PlanPurchase = mongoose.model("PlanPurchase", planPurchaseSchema);

export default PlanPurchase;
