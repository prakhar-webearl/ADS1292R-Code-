import express from "express";
import {
  storeAbnormality,
  getAbnormalitiesForToday,
  getAbnormalitiesByDate,
  getAbnormalitiesDateRange,
  getCriticalAbnormalities,
  deleteAbnormalitiesByDate,
  getAbnormalityAndEcgByUserAndDate,
} from "../controllers/abnormalityController.js";

const router = express.Router();

// Store new abnormality
router.post("/", storeAbnormality);

// Get abnormalities for today
router.get("/user/:userId", getAbnormalitiesForToday);

// Get critical abnormalities only
router.get("/user/:userId/critical", getCriticalAbnormalities);

// Get abnormalities for a specific date
router.get("/user/:userId/date/:date", getAbnormalitiesByDate);

// Get abnormalities within a date range
router.get("/user/:userId/range", getAbnormalitiesDateRange);

// Get abnormality and ECG data details for a specific date
router.get("/user/:userId/date/:date/details", getAbnormalityAndEcgByUserAndDate);

// Delete abnormalities for a specific date
router.delete("/user/:userId/date/:date", deleteAbnormalitiesByDate);

export default router;
