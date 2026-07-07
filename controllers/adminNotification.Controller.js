import AdminNotification from "../models/adminNotificationModel.js";
import { emitAdminNotification } from "../services/notificationSocket.js";

const createAdminNotification = async ({ title, desc, type, metadata = {} }) => {
  try {
    const notification = await AdminNotification.create({
      title,
      desc,
      type,
      metadata,
    });

    emitAdminNotification(notification);
    return notification;
  } catch (error) {
    console.error("Error creating admin notification:", error);
    return null;
  }
};

const getAdminNotifications = async (req, res) => {
  try {
    const { search, type, isRead, page = 1, limit = 10 } = req.query;
    
    let query = {};
    
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { desc: { $regex: search, $options: "i" } }
      ];
    }
    
    if (type && type !== "ALL") {
      query.type = type;
    }
    
    if (isRead !== undefined) {
      query.isRead = isRead === "true";
    }

    const notifications = await AdminNotification.find(query)
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean();

    const total = await AdminNotification.countDocuments(query);

    return res.status(200).json({
      success: true,
      notifications,
      total,
      pages: Math.ceil(total / Number(limit)),
      currentPage: Number(page)
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching admin notifications",
      error: error.message,
    });
  }
};

const markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const notification = await AdminNotification.findByIdAndUpdate(
      id,
      { isRead: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    return res.status(200).json({
      success: true,
      notification,
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error marking notification as read",
      error: error.message,
    });
  }
};

const markAllAsRead = async (req, res) => {
  try {
    await AdminNotification.updateMany({ isRead: false }, { isRead: true });
    return res.status(200).json({
      success: true,
      message: "All notifications marked as read",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error marking all as read",
      error: error.message,
    });
  }
};

const clearRegistry = async (req, res) => {
  try {
    await AdminNotification.deleteMany({});
    return res.status(200).json({
      success: true,
      message: "Registry cleared successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error clearing registry",
      error: error.message,
    });
  }
};

export {
  createAdminNotification,
  getAdminNotifications,
  markAsRead,
  markAllAsRead,
  clearRegistry,
};
