import mongoose from "mongoose";

function getISTTime() {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  return new Date(now.getTime() + istOffset);
}

const directOrderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 1,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
    },
    currency: {
      type: String,
      default: "INR",
      uppercase: true,
      trim: true,
    },
    customerName: {
      type: String,
      required: true,
      trim: true,
    },
    customerEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    customerPhone: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      street: {
        type: String,
        required: true,
        trim: true,
      },
      city: {
        type: String,
        required: true,
        trim: true,
      },
      state: {
        type: String,
        required: true,
        trim: true,
      },
      zipcode: {
        type: String,
        required: true,
        trim: true,
      },
      country: {
        type: String,
        required: true,
        trim: true,
      },
    },
    razorpayOrderId: {
      type: String,
      required: true,
      unique: true,
    },
    razorpayPaymentId: {
      type: String,
      default: "",
    },
    razorpaySignature: {
      type: String,
      default: "",
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed"],
      default: "pending",
    },
    paymentMethod: {
      type: String,
      enum: ["unknown", "upi", "card", "netbanking", "wallet", "emi", "other"],
      default: "unknown",
      lowercase: true,
      trim: true,
    },
    shippingStatus: {
      type: String,
      enum: [
        "not_required",
        "pending",
        "packed",
        "shipped",
        "out_for_delivery",
        "delivered",
        "returned",
        "cancelled",
      ],
      default: "pending",
    },
    shippingStatusUpdatedAt: {
      type: Date,
      default: () => getISTTime(),
    },
    shippingHistory: [
      {
        status: {
          type: String,
          enum: [
            "not_required",
            "pending",
            "packed",
            "shipped",
            "out_for_delivery",
            "delivered",
            "returned",
            "cancelled",
          ],
          required: true,
        },
        changedAt: {
          type: Date,
          default: () => getISTTime(),
        },
        changedByRole: {
          type: String,
          enum: ["system", "user", "admin"],
          default: "system",
        },
        changedById: {
          type: String,
          default: "",
          trim: true,
        },
        note: {
          type: String,
          default: "",
          trim: true,
        },
      },
    ],
    orderStatus: {
      type: String,
      enum: ["pending", "booked", "cancelled"],
      default: "pending",
    },
    orderStatusUpdatedAt: {
      type: Date,
      default: () => getISTTime(),
    },
    statusHistory: [
      {
        status: {
          type: String,
          enum: ["pending", "booked", "cancelled"],
          required: true,
        },
        changedAt: {
          type: Date,
          default: () => getISTTime(),
        },
        changedByRole: {
          type: String,
          enum: ["system", "user", "admin"],
          default: "system",
        },
        changedById: {
          type: String,
          default: "",
          trim: true,
        },
        note: {
          type: String,
          default: "",
          trim: true,
        },
      },
    ],
    orderExpiresAt: {
      type: Date,
      required: true,
    },
    bookedAt: {
      type: Date,
    },
  },
  {
    timestamps: {
      currentTime: () => getISTTime(),
    },
  },
);

directOrderSchema.index({ userId: 1, createdAt: -1 });

const DirectOrder = mongoose.model("DirectOrder", directOrderSchema);

export default DirectOrder;
