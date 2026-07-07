import mongoose from "mongoose";

function getISTTime() {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  return new Date(now.getTime() + istOffset);
}

const consultancySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    full_name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
    },
    consultationDate: {
      type: Date,
      required: true,
    },
    timeSlot: {
      type: String,
      required: true,
      trim: true,
    },
    consultationDurationMinutes: {
      type: Number,
      required: true,
    },
    consultationLanguage: {
      type: String,
      required: true,
      trim: true,
    },
    monitorId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    planPurchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PlanPurchase",
      default: null,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: "INR",
      uppercase: true,
      trim: true,
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
    bookingStatus: {
      type: String,
      enum: ["pending", "booked", "cancelled"],
      default: "pending",
    },
    orderExpiresAt: {
      type: Date,
      required: true,
    },
    bookedAt: {
      type: Date,
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Doctor",
      default: null,
    },
    doctorAssignedAt: {
      type: Date,
      default: null,
    },
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AddedUser",
      default: null,
    },
    memberName: {
      type: String,
      trim: true,
      default: "",
    },
    memberRelation: {
      type: String,
      trim: true,
      default: "",
    },
    doctorAssignmentStatus: {
      type: String,
      enum: ["unassigned", "pending", "approved", "rejected"],
      default: "unassigned",
    },
    doctorRespondedAt: {
      type: Date,
      default: null,
    },
    doctorRejectionReason: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    timestamps: {
      currentTime: () => getISTTime(),
    },
  },
);

consultancySchema.index({ consultationDate: 1, timeSlot: 1, bookingStatus: 1 });
consultancySchema.index({ doctorId: 1 });
consultancySchema.index({ doctorAssignmentStatus: 1 });

const Consultancy = mongoose.model("Consultancy", consultancySchema);

export default Consultancy;
