import express from "express";
import {
  createNotification,
  getAllNotifications,
  getNotificationById,
  updateNotification,
  deleteNotification,
} from "../controllers/notification.Controller.js";
import { AppAdminprotect } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/create/:userId", createNotification);
router.get("/getAll", getAllNotifications);
router.get("/getById/:id", getNotificationById);
router.put("/update/:id", updateNotification);
router.delete("/delete/:id", AppAdminprotect, deleteNotification);

export default router;
