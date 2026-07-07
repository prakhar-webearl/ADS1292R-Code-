import express from "express";
import { AppAdminprotect, protect, protectDoctor } from "../middleware/authMiddleware.js";
import {
  createConsultancyOrder,
  getAllConsultancyBookingsForAdmin,
  assignDoctorToConsultancy,
  getMyConsultancyBookings,
  getConsultancyDetailsById,
  getDoctorConsultancies,
  getUnassignedConsultancies,
  respondToConsultancyAssignment,
  verifyConsultancyPayment,
} from "../controllers/consultancy.Controller.js";

const router = express.Router();

// User endpoints
router.post("/create-order", protect, createConsultancyOrder); 
router.post("/verify-payment", protect, verifyConsultancyPayment);
router.get("/my-bookings", protect, getMyConsultancyBookings);
router.get("/details/:consultancyId", getConsultancyDetailsById);

// Admin endpoints
router.get("/admin/getAll", AppAdminprotect, getAllConsultancyBookingsForAdmin);
router.get("/admin/unassigned", AppAdminprotect, getUnassignedConsultancies);
router.patch("/admin/assign-doctor", AppAdminprotect, assignDoctorToConsultancy);

// Doctor endpoints
router.get("/doctor/my-consultancies", protectDoctor, getDoctorConsultancies);
router.patch("/doctor/respond-assignment", protectDoctor, respondToConsultancyAssignment);

export default router;
