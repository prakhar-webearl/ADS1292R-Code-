import express from "express";
import {
  getAdminNotifications,
  markAsRead,
  markAllAsRead,
  clearRegistry,
} from "../controllers/adminNotification.Controller.js";

const router = express.Router();

router.get("/", getAdminNotifications);
router.patch("/mark-read/:id", markAsRead);
router.patch("/mark-all-read", markAllAsRead);
router.delete("/clear", clearRegistry);

export default router;
