import express from "express";
import {
  getActiveConfig,
  getAllConfigs,
  createConfig,
  updateConfig,
  setActiveConfig,
  deleteConfig,
} from "../controllers/zegoConfigController.js";
import { AppAdminprotect } from "../middleware/authMiddleware.js";

const router = express.Router();

// ── Public — Doctor/User frontend fetches active ZegoCloud config ─────────────
// No auth required: this only returns read-only appID + serverSecret for the
// video SDK. The actual video room is secured by ZegoCloud tokens separately.
router.get("/active", getActiveConfig);

// ── Admin only ────────────────────────────────────────────────────────────────
router.get("/", AppAdminprotect, getAllConfigs);
router.post("/", AppAdminprotect, createConfig);
router.put("/:id", AppAdminprotect, updateConfig);
router.patch("/:id/set-active", AppAdminprotect, setActiveConfig);
router.delete("/:id", AppAdminprotect, deleteConfig);

export default router;
