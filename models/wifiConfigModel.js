import mongoose from "mongoose";

function getISTTime() {
  const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC +5:30
  const now = new Date();
  return new Date(now.getTime() + istOffset);
}

const wifiConfigSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Please provide a user ID"],
    },
    deviceId: {
      type: String,
      required: [true, "Please provide a device ID"],
      trim: true,
    },
    ssid: {
      type: String,
      required: [true, "Please provide WiFi SSID"],
      trim: true,
    },
    password: {
      type: String,
      required: [true, "Please provide WiFi password"],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    connectedAt: {
      type: Date,
      default: getISTTime,
    },
    lastUpdated: {
      type: Date,
      default: getISTTime,
    },
  },
  {
    timestamps: {
      currentTime: () => getISTTime(),
    },
  }
);

wifiConfigSchema.index({ userId: 1, deviceId: 1 }, { unique: true });

const WifiConfig = mongoose.model("WifiConfig", wifiConfigSchema);

export default WifiConfig;
