import express from "express";
import {
  initiateCall,
  handleCallEvent,
  completeCall,
  getCallStatus,
  requestExtension,
  respondToExtension,
} from "../controllers/videoCallController.js";
import { protectDoctor, protectUniversal } from "../middleware/authMiddleware.js";

const router = express.Router();

// ── Status & event (Doctor + User) ───────────────────────────────────────────
router.get("/:roomId", protectUniversal, getCallStatus);
router.post("/event", protectUniversal, handleCallEvent);
router.post("/complete", protectUniversal, completeCall);

// ── Extension flow (Doctor or User) ──────────────────────────────────────────
router.post("/request-extension", protectUniversal, requestExtension);
router.post("/respond-extension", protectUniversal, respondToExtension);

// ── Initiation (Doctor only) ──────────────────────────────────────────────────
router.post("/initiate", protectDoctor, initiateCall);

export default router;
