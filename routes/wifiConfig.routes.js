import express from "express";
import {
  saveWifiConfig,
  getWifiConfigByUser,
  getWifiConfigByDevice,
  deleteWifiConfig,
} from "../controllers/wifiConfigController.js";

const router = express.Router();

// Save or update WiFi credentials
router.post("/", saveWifiConfig);

// Get all WiFi credentials for a user
router.get("/user/:userId", getWifiConfigByUser);

// Get WiFi credentials for a device
router.get("/device/:deviceId", getWifiConfigByDevice);

// Delete WiFi credentials for a user/device pair
router.delete("/user/:userId/device/:deviceId", deleteWifiConfig);

export default router;
