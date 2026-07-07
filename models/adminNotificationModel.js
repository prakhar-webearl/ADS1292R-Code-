import mongoose from "mongoose";

const adminNotificationSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    desc: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ["ALERT", "SYSTEM", "PAYMENT", "REPORT"],
      default: "SYSTEM",
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    metadata: {
      type: Object,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

const AdminNotification = mongoose.model(
  "AdminNotification",
  adminNotificationSchema
);

export default AdminNotification;
