import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import connectDB from "./config/db.js";
import ecgRoutes from "./routes/ecgRoutes.js";
import resultRoutes from "./routes/resultRoutes.js";
import EcgData from "./models/EcgData.js";

import appAdminRoutes from "./routes/appAdmin.routes.js";

// USER ROUTES
import userRoutes from "./routes/user.routes.js";

// ADD USER ROUTES
import addUserRoutes from "./routes/addUser.routes.js";

// PLAN ROUTES
import planRoutes from "./routes/plan.routes.js";

// TEST ROUTES
import testRoutes from "./routes/test.routes.js";

// Article ROUTES
import articleRoutes from "./routes/article.routes.js";

// HELP & Support ROUTES
import helpRoutes from "./routes/help.routes.js";

// FAQ ROUTES
import faqRoutes from "./routes/faq.routes.js";

// PrivacyPolicy
import PrivacyPolicy from "./routes/privacypolicy.routes.js";

// Terms & Condition
import TermsCondition from "./routes/termsCondition.routes.js";

// Coupon
import Coupon from "./routes/coupon.routes.js";

// appliedCoupon
import AppliedCoupon from "./routes/appliedCoupon.routes.js";
// Device
import Device from "./routes/device.routes.js";

// WiFi Config
import wifiConfigRoutes from "./routes/wifiConfig.routes.js";

// Abnormality
import abnormalityRoutes from "./routes/abnormality.routes.js";
import consultancyRoutes from "./routes/consultancy.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import adminNotificationRoutes from "./routes/adminNotification.routes.js";
import storeRoutes from "./routes/store.routes.js";
import doctorRoutes from "./routes/doctor.routes.js";
import videoCallRoutes from "./routes/videoCallRoutes.js";
import zegoConfigRoutes from "./routes/zegoConfig.routes.js";
import { setNotificationIO } from "./services/notificationSocket.js";

dotenv.config();
connectDB();

const app = express();

// Enable CORS for all domains
app.use(cors());

// Middleware to parse incoming JSON payload
app.use(express.json());
app.use("/uploads", express.static("uploads"));
// app.use('/plan', express.static('uploads/plans'));
app.use(express.urlencoded({ extended: true }));

const port = process.env.PORT || 3000;

// Mount the API routers
app.use("/api/ecg", ecgRoutes);
app.use("/api/result", resultRoutes);

// user routes
app.use("/api/appAdmin", appAdminRoutes);
app.use("/api/user", userRoutes);
app.use("/api/adduser", addUserRoutes);
app.use("/api/plan", planRoutes);
app.use("/api/test", testRoutes);
app.use("/api/article", articleRoutes);
app.use("/api/help", helpRoutes);
app.use("/api/faq", faqRoutes);
app.use("/api/privacypolicy", PrivacyPolicy);
app.use("/api/termscondition", TermsCondition);
app.use("/api/coupon", Coupon);
app.use("/api/appliedCoupon", AppliedCoupon);
app.use("/api/device", Device);
app.use("/api/wifi-config", wifiConfigRoutes);
app.use("/api/abnormality", abnormalityRoutes);
app.use("/api/consultancy", consultancyRoutes);
app.use("/api/notification", notificationRoutes);
app.use("/api/admin-notification", adminNotificationRoutes);
app.use("/api/store", storeRoutes);
app.use("/api/doctor", doctorRoutes);
app.use("/api/video-call", videoCallRoutes);
app.use("/api/zego-config", zegoConfigRoutes);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

// ==== WEB SOCKET & BATCHING LOGIC ====
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

setNotificationIO(io);
app.set("io", io); // Expose io to controllers for real-time broadcasts

let ecgDataBuffer = [];
let isEcgWriteInProgress = false;
let droppedEcgPayloadCount = 0;

const ECG_MAX_BUFFER_RECORDS = Number(
  process.env.ECG_MAX_BUFFER_RECORDS || 10000,
);
const ECG_BATCH_INSERT_SIZE = Number(process.env.ECG_BATCH_INSERT_SIZE || 500);
const ECG_WRITE_INTERVAL_MS = Number(process.env.ECG_WRITE_INTERVAL_MS || 2000);
const ECG_MAX_SAMPLES_PER_PAYLOAD = Number(
  process.env.ECG_MAX_SAMPLES_PER_PAYLOAD || 2000,
);

const isValidEcgPayload = (payload) => {
  if (!payload || typeof payload !== "object") return false;
  if (!payload.deviceId || typeof payload.deviceId !== "string") return false;
  if (!Array.isArray(payload.data) || payload.data.length === 0) return false;
  if (payload.data.length > ECG_MAX_SAMPLES_PER_PAYLOAD) return false;
  return payload.data.every((value) => Number.isFinite(value));
};

io.on("connection", (socket) => {
  console.log(`Device connected via WebSocket: ${socket.id}`);

  socket.on("notification:subscribe", ({ userId, userType = "User" }) => {
    if (userType === "Admin") {
      socket.join("admin_room");
      return;
    }
    if (!userId) return;
    const room =
      userType === "Doctor"
        ? `notification:doctor:${userId}`
        : `notification:user:${userId}`;
    socket.join(room);
  });

  socket.on("notification:unsubscribe", ({ userId, userType = "User" }) => {
    if (userType === "Admin") {
      socket.leave("admin_room");
      return;
    }
    if (!userId) return;
    const room =
      userType === "Doctor"
        ? `notification:doctor:${userId}`
        : `notification:user:${userId}`;
    socket.leave(room);
  });

  // Listen for continuous 'ecg_stream' events from the device
  socket.on("ecg_stream", (payload) => {
    // payload should be { deviceId, seq, sr, lo, data: [...] }
    if (!isValidEcgPayload(payload)) {
      return;
    }

    if (ecgDataBuffer.length >= ECG_MAX_BUFFER_RECORDS) {
      droppedEcgPayloadCount += 1;
      if (droppedEcgPayloadCount % 100 === 0) {
        console.warn(
          `[ECG Buffer] Dropped ${droppedEcgPayloadCount} payloads due to full buffer (${ECG_MAX_BUFFER_RECORDS}).`,
        );
      }
      return;
    }

    ecgDataBuffer.push(payload);
  });

  socket.on("disconnect", () => {
    console.log(`Device disconnected: ${socket.id}`);
  });
});

// Batch Insert Process: Runs every 5 seconds to prevent DB overload
setInterval(async () => {
  if (isEcgWriteInProgress || ecgDataBuffer.length === 0) {
    return;
  }

  isEcgWriteInProgress = true;

  try {
    let totalSaved = 0;
    while (ecgDataBuffer.length > 0) {
      const dataToSave = ecgDataBuffer.splice(0, ECG_BATCH_INSERT_SIZE);
      await EcgData.insertMany(dataToSave, { ordered: false });
      totalSaved += dataToSave.length;

      // Keep one flush cycle bounded to avoid starving the event loop.
      if (totalSaved >= ECG_MAX_BUFFER_RECORDS) {
        break;
      }
    }

    if (totalSaved > 0) {
      console.log(
        `[Batch DB Write] Saved ${totalSaved} ECG records to MongoDB.`,
      );
    }
  } catch (error) {
    console.error("[Batch DB Write] Error saving records:", error.message);
  } finally {
    isEcgWriteInProgress = false;
  }
}, ECG_WRITE_INTERVAL_MS);

// Start the HTTP & WebSocket server
httpServer.listen(port, () => {
  console.log(`Example app listening on port ${port} with WebSockets enabled`);
});
