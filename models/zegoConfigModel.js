import mongoose from "mongoose";

const zegoConfigSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      default: "Primary ZegoCloud Configuration",
      trim: true,
    },
    appID: {
      type: Number,
      required: true,
    },
    serverSecret: {
      type: String,
      required: true,
      trim: true,
    },
    appSign: {
      type: String,
      default: "",
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    updatedBy: {
      type: String,
      default: "Admin",
    },
  },
  { timestamps: true }
);

const ZegoConfig = mongoose.model("ZegoConfig", zegoConfigSchema);
export default ZegoConfig;
