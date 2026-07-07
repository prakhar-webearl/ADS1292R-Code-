import WifiConfig from "../models/wifiConfigModel.js";

function getISTTime() {
  const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC +5:30
  const now = new Date();
  return new Date(now.getTime() + istOffset);
}

// @desc    Save or update WiFi credentials for a device
// @route   POST /api/wifi-config
// @access  Public
export const saveWifiConfig = async (req, res) => {
  try {
    const { userId, deviceId, ssid, password, isActive } = req.body;

    // 🔥 Support ID-only updates (runtime member switch) without WiFi creds
    if (!userId || !deviceId) {
      return res.status(400).json({
        success: false,
        message: "userId and deviceId are required",
      });
    }

    // If BOTH ssid and password provided: full setup/update.
    // If NEITHER: runtime member switch (userId update only).
    const hasWiFiCreds = !!ssid && !!password;

    let wifiConfig;

    if (hasWiFiCreds) {
      // Device-centric upsert: one active mapping per physical device.
      wifiConfig = await WifiConfig.findOneAndUpdate(
        { deviceId },
        {
          $set: {
            userId,
            deviceId,
            ssid,
            password,
            isActive: typeof isActive === "boolean" ? isActive : true,
            lastUpdated: getISTTime(),
          },
          $setOnInsert: {
            connectedAt: getISTTime(),
          },
        },
        { upsert: true, returnDocument: 'after', runValidators: true }
      );
    } else {
      // Runtime user switch: do not create a new row without WiFi creds.
      wifiConfig = await WifiConfig.findOneAndUpdate(
        { deviceId },
        {
          $set: {
            userId,
            isActive: typeof isActive === "boolean" ? isActive : true,
            lastUpdated: getISTTime(),
          },
        },
        { returnDocument: 'after', runValidators: true }
      );

      if (!wifiConfig) {
        return res.status(404).json({
          success: false,
          message:
            "Device config not found. Complete setup with ssid/password first.",
        });
      }
    }

    res.status(200).json({
      success: true,
      message: "WiFi credentials saved successfully",
      data: wifiConfig,
    });
  } catch (error) {
    console.error(`Error saving WiFi config: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Get all WiFi configs for a user
// @route   GET /api/wifi-config/user/:userId
// @access  Public
export const getWifiConfigByUser = async (req, res) => {
  try {
    const { userId } = req.params;

    const configs = await WifiConfig.find({ userId }).sort({ updatedAt: -1 });

    res.status(200).json({
      success: true,
      count: configs.length,
      data: configs,
    });
  } catch (error) {
    console.error(`Error fetching WiFi configs: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Get WiFi config for a device
// @route   GET /api/wifi-config/device/:deviceId
// @access  Public
export const getWifiConfigByDevice = async (req, res) => {
  try {
    const { deviceId } = req.params;

    const config = await WifiConfig.findOne({ deviceId }).sort({ lastUpdated: -1 });

    if (!config) {
      return res.status(404).json({
        success: false,
        message: "WiFi config not found",
      });
    }

    res.status(200).json({
      success: true,
      data: config,
    });
  } catch (error) {
    console.error(`Error fetching WiFi config: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// @desc    Delete WiFi config for a device
// @route   DELETE /api/wifi-config/user/:userId/device/:deviceId
// @access  Public
export const deleteWifiConfig = async (req, res) => {
  try {
    const { userId, deviceId } = req.params;

    const result = await WifiConfig.deleteOne({ userId, deviceId });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "WiFi config not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "WiFi config deleted successfully",
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error(`Error deleting WiFi config: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};
