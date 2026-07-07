import mongoose from "mongoose";

function getISTTime() {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  return new Date(now.getTime() + istOffset);
}

const notificationSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    notification: {
      type: String,
      required: true,
      trim: true,
    },
    details: {
      type: String,
      trim: true,
      default: "",
    },
    targetUserId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
  },
  {
    timestamps: {
      currentTime: () => getISTTime(),
    },
  },
);

const Notification = mongoose.model("Notification", notificationSchema);

export default Notification;
