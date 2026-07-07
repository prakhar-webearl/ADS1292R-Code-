import express from "express";
import multer from "multer";
import {
    registerDoctor,
    loginDoctor,
    getDoctorProfile,
    updateDoctorProfile,
    doctorChangePassword,
    requestDoctorForgotPasswordOtp,
    verifyDoctorForgotPasswordOtp,
    resetDoctorPasswordWithOtp,
    getPendingDoctors,
    getAdminDoctors,
    getAdminDoctorById,
    updateDoctorStatus,
    updateDoctorApprovalStatus,
    createDoctorBlog,
    updateDoctorBlog,
    deleteDoctorBlog,
    getDoctorOwnBlogs,
    getApprovedDoctorBlogs,
    getDoctorBlogById,
    getPendingDoctorBlogs,
    getAdminDoctorBlogs,
    updateDoctorBlogApprovalStatus,
    getActiveApprovedDoctors,
} from "../controllers/doctor.Controller.js";
import { AppAdminprotect, protectDoctor } from "../middleware/authMiddleware.js";
import { getConsultancyDetailsById } from "../controllers/consultancy.Controller.js";
import articleupload from "../middleware/articlemulter.js";

const router = express.Router();

const doctorBlogPhotoUpload = (req, res, next) => {
    articleupload.single("photo")(req, res, (error) => {
        if (!error) {
            return next();
        }

        if (error instanceof multer.MulterError) {
            const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
            return res.status(status).json({
                success: false,
                message: `Upload error: ${error.message}`,
                code: error.code,
            });
        }

        return res.status(400).json({
            success: false,
            message: error.message || "Invalid file upload",
        });
    });
};

router.post("/register", registerDoctor);
router.post("/login", loginDoctor);

router.post("/forgot-password/request-otp", requestDoctorForgotPasswordOtp);
router.post("/forgot-password/verify-otp", verifyDoctorForgotPasswordOtp);
router.post("/forgot-password/reset", resetDoctorPasswordWithOtp);

router.get("/profile", protectDoctor, getDoctorProfile);
router.put("/profile", protectDoctor, updateDoctorProfile);
router.put("/change-password", protectDoctor, doctorChangePassword);

router.post("/blog/create", protectDoctor, doctorBlogPhotoUpload, createDoctorBlog);
router.put("/blog/update/:id", protectDoctor, doctorBlogPhotoUpload, updateDoctorBlog);
router.delete("/blog/delete/:id", protectDoctor, deleteDoctorBlog);
router.get("/blog/my", protectDoctor, getDoctorOwnBlogs);

router.get("/blog/list", getApprovedDoctorBlogs);
router.get("/blog/:id", getDoctorBlogById);

router.get("/admin/pending", AppAdminprotect, getPendingDoctors);
router.get("/admin/list", AppAdminprotect, getAdminDoctors);
router.get("/admin/active-approved", AppAdminprotect, getActiveApprovedDoctors);
router.get("/admin/:id", AppAdminprotect, getAdminDoctorById);
router.patch("/admin/:id/status", AppAdminprotect, updateDoctorStatus);
router.patch("/admin/:id/approval", AppAdminprotect, updateDoctorApprovalStatus);
router.get("/consultancy/details/:consultancyId", protectDoctor, getConsultancyDetailsById);

router.get("/admin/blog/list", AppAdminprotect, getAdminDoctorBlogs);
router.get("/admin/blog/pending", AppAdminprotect, getPendingDoctorBlogs);
router.patch("/admin/blog/:id/approval", AppAdminprotect, updateDoctorBlogApprovalStatus);

export default router;
