import mongoose from "mongoose";
import Notification from "../models/notificationModel.js";
import { emitNewNotification } from "../services/notificationSocket.js";
import { createAdminNotification } from "./adminNotification.Controller.js";

const createNotification = async (req, res) => {
  try {
    const { title, notification, details } = req.body;
    const { userId } = req.params;
    const targetUserId = userId || req.body.targetUserId;

    if (!title || !notification || !targetUserId) {
      return res.status(400).json({
        success: false,
        message: "title, notification and userId are required",
      });
    }

    const createdNotification = await Notification.create({
      title,
      notification,
      details,
      targetUserId: String(targetUserId).trim(),
    });

    emitNewNotification(createdNotification);

    // Also notify admin
    await createAdminNotification({
      title: `User Notification Sent`,
      desc: `Notification "${title}" sent to user ${targetUserId}`,
      type: "SYSTEM",
      category: "INFO",
      metadata: { targetUserId, title }
    });

    return res.status(201).json({
      success: true,
      message: "Notification created successfully",
      notification: createdNotification,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error creating notification",
      error: error.message,
    });
  }
};

const getAllNotifications = async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const notifications = await Notification.find({ targetUserId: String(userId).trim() })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Notifications fetched successfully",
      totalNotifications: notifications.length,
      notifications,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching notifications",
      error: error.message,
    });
  }
};

const getNotificationById = async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid notification id",
      });
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const notification = await Notification.findOne({
      _id: id,
      targetUserId: String(userId).trim(),
    }).lean();

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Notification fetched successfully",
      notification,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching notification",
      error: error.message,
    });
  }
};

const updateNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, notification, details, targetUserId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid notification id",
      });
    }

    if (!title || !notification || !targetUserId) {
      return res.status(400).json({
        success: false,
        message: "title, notification and targetUserId are required",
      });
    }

    const updatedNotification = await Notification.findByIdAndUpdate(
      id,
      {
        title,
        notification,
        details,
        targetUserId: String(targetUserId).trim(),
      },
      {
        new: true,
        runValidators: true,
      },
    );

    if (!updatedNotification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Notification updated successfully",
      notification: updatedNotification,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error updating notification",
      error: error.message,
    });
  }
};

const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid notification id",
      });
    }

    const deletedNotification = await Notification.findByIdAndDelete(id);

    if (!deletedNotification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Notification deleted successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error deleting notification",
      error: error.message,
    });
  }
};

export {
  createNotification,
  getAllNotifications,
  getNotificationById,
  updateNotification,
  deleteNotification,
};

