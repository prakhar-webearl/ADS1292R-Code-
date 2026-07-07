import ZegoConfig from "../models/zegoConfigModel.js";
import { emitAdminNotification } from "../services/notificationSocket.js";

// ─── Helper: emit config update to all connected clients ─────────────────────
function broadcastConfigUpdate(io, config) {
  if (!io) return;
  // Emit to all connected sockets so VideoConsultation reacts in real-time
  io.emit("zego_config:update", {
    success: true,
    config: sanitizeConfig(config),
  });
}

// Never send serverSecret to non-admin consumers
function sanitizeConfig(config) {
  if (!config) return null;
  return {
    _id: config._id,
    label: config.label,
    appID: config.appID,
    serverSecret: config.serverSecret, // doctors need this for token generation
    appSign: config.appSign,
    isActive: config.isActive,
    description: config.description,
    updatedAt: config.updatedAt,
    createdAt: config.createdAt,
  };
}

// ─── GET active config (used by VideoConsultation.jsx) ───────────────────────
export const getActiveConfig = async (req, res) => {
  try {
    const config = await ZegoConfig.findOne({ isActive: true }).sort({ updatedAt: -1 });
    if (!config) {
      return res.status(404).json({
        success: false,
        message: "No active ZegoCloud configuration found. Please set one up in the admin panel.",
      });
    }
    res.status(200).json({ success: true, config: sanitizeConfig(config) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error", error: error.message });
  }
};

// ─── GET all configs (Admin) ──────────────────────────────────────────────────
export const getAllConfigs = async (req, res) => {
  try {
    const configs = await ZegoConfig.find().sort({ createdAt: -1 });
    res.status(200).json({ success: true, configs });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error", error: error.message });
  }
};

// ─── CREATE new config (Admin) ────────────────────────────────────────────────
export const createConfig = async (req, res) => {
  try {
    const { label, appID, serverSecret, appSign, description, isActive } = req.body;

    if (!appID || !serverSecret) {
      return res.status(400).json({ success: false, message: "AppID and Server Secret are required." });
    }

    // If this new config is active, deactivate all others
    if (isActive) {
      await ZegoConfig.updateMany({}, { isActive: false });
    }

    const config = await ZegoConfig.create({
      label: label || "ZegoCloud Configuration",
      appID: Number(appID),
      serverSecret: serverSecret.trim(),
      appSign: appSign ? appSign.trim() : "",
      description: description || "",
      isActive: isActive !== false,
      updatedBy: req.user?.full_name || "Admin",
    });

    // Broadcast to all connected clients
    const io = req.app.get("io");
    if (isActive) broadcastConfigUpdate(io, config);

    emitAdminNotification({
      type: "SYSTEM",
      category: "SYSTEM",
      title: "ZegoCloud Config Created",
      message: `A new ZegoCloud configuration "${config.label}" has been created.`,
      severity: "info",
    });

    res.status(201).json({ success: true, message: "Configuration created.", config });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error", error: error.message });
  }
};

// ─── UPDATE config (Admin) ────────────────────────────────────────────────────
export const updateConfig = async (req, res) => {
  try {
    const { id } = req.params;
    const { label, appID, serverSecret, appSign, description, isActive } = req.body;

    const config = await ZegoConfig.findById(id);
    if (!config) return res.status(404).json({ success: false, message: "Config not found." });

    // If setting this one active, deactivate all others first
    if (isActive === true) {
      await ZegoConfig.updateMany({ _id: { $ne: id } }, { isActive: false });
    }

    if (label !== undefined) config.label = label;
    if (appID !== undefined) config.appID = Number(appID);
    if (serverSecret !== undefined) config.serverSecret = serverSecret.trim();
    if (appSign !== undefined) config.appSign = appSign.trim();
    if (description !== undefined) config.description = description;
    if (isActive !== undefined) config.isActive = isActive;
    config.updatedBy = req.user?.full_name || "Admin";

    await config.save();

    // Broadcast real-time update to all clients if this is the active config
    const io = req.app.get("io");
    if (config.isActive) broadcastConfigUpdate(io, config);

    emitAdminNotification({
      type: "SYSTEM",
      category: "SYSTEM",
      title: "ZegoCloud Config Updated",
      message: `ZegoCloud configuration "${config.label}" has been updated. All active video calls will use new credentials.`,
      severity: "warning",
    });

    res.status(200).json({ success: true, message: "Configuration updated.", config });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error", error: error.message });
  }
};

// ─── SET ACTIVE config (Admin) ────────────────────────────────────────────────
export const setActiveConfig = async (req, res) => {
  try {
    const { id } = req.params;
    await ZegoConfig.updateMany({}, { isActive: false });
    const config = await ZegoConfig.findByIdAndUpdate(id, { isActive: true }, { new: true });
    if (!config) return res.status(404).json({ success: false, message: "Config not found." });

    // Broadcast real-time switch
    const io = req.app.get("io");
    broadcastConfigUpdate(io, config);

    res.status(200).json({ success: true, message: "Active configuration switched.", config });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error", error: error.message });
  }
};

// ─── DELETE config (Admin) ────────────────────────────────────────────────────
export const deleteConfig = async (req, res) => {
  try {
    const { id } = req.params;
    const config = await ZegoConfig.findByIdAndDelete(id);
    if (!config) return res.status(404).json({ success: false, message: "Config not found." });

    res.status(200).json({ success: true, message: "Configuration deleted." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error", error: error.message });
  }
};
