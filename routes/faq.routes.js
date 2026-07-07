import express from "express";
import {
  createFaq,
  getAllFaqs,
  getFaqById,
  updateFaq,
  deleteFaq,
} from "../controllers/faq.Controller.js";
import { AppAdminprotect } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/create", AppAdminprotect, createFaq);
router.get("/getAll", getAllFaqs);
router.get("/getById/:id", AppAdminprotect, getFaqById);
router.put("/update/:id", AppAdminprotect, updateFaq);
router.delete("/delete/:id", AppAdminprotect, deleteFaq);

export default router;
