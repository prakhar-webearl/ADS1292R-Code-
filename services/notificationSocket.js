let notificationIO = null;

const setNotificationIO = (ioInstance) => {
  notificationIO = ioInstance;
};

const emitNewNotification = (notification) => {
  if (!notificationIO) {
    return;
  }

  const payload = {
    success: true,
    message: "New notification posted",
    notification,
  };

  if (notification?.targetUserId) {
    notificationIO.to(`notification:user:${notification.targetUserId}`).emit("notification:new", payload);
    return;
  }

  notificationIO.emit("notification:new", payload);
};

const emitVideoCallUpdate = (id, type, callData) => {
  if (!notificationIO) return;

  const room = type === "Doctor" ? `notification:doctor:${id}` : `notification:user:${id}`;
  notificationIO.to(room).emit("video_call:update", {
    success: true,
    callData,
  });
};

const emitAdminNotification = (notification) => {
  if (!notificationIO) return;

  const payload = {
    success: true,
    message: "New admin notification",
    notification,
  };

  // Join admin room if needed, or broadcast to all
  notificationIO.to("admin_room").emit("notification:admin:new", payload);
};

export { setNotificationIO, emitNewNotification, emitAdminNotification, emitVideoCallUpdate };
