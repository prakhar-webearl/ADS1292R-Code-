import express from 'express';
import {
    createPlan, 
    getAdminPlans,
    updatePlan, 
    getAdminPlanById,
    deletePlan ,
    planStatusUpdate,
    getUserPlans,
    getUserPlanById,
    purchasePlan,
    createPlanPurchaseOrder,
    verifyPlanPurchasePayment,
    getMyPlanPurchases,
    getMyCurrentPlan,
    getAllPlanPurchases,
    getPlanPurchaseById,
    updatePlanPurchaseStatus,
    getDoctorPatientCurrentPlan
} from '../controllers/plan.Controller.js';
import { AppAdminprotect, protect, protectDoctor } from '../middleware/authMiddleware.js'

const router = express.Router();

// Admin plan CRUD
router.post('/admin/create', AppAdminprotect, createPlan);
router.get('/admin/list', AppAdminprotect, getAdminPlans);
router.get('/admin/:id', AppAdminprotect, getAdminPlanById);
router.put('/admin/:id', AppAdminprotect, updatePlan);
router.delete('/admin/:id', AppAdminprotect, deletePlan);
router.patch('/admin/:id/status', AppAdminprotect, planStatusUpdate);

// Admin purchase management
router.get('/admin/purchases', AppAdminprotect, getAllPlanPurchases);
router.get('/admin/purchases/:id', AppAdminprotect, getPlanPurchaseById);
router.patch('/admin/purchases/:id/status', AppAdminprotect, updatePlanPurchaseStatus);

// User plan and purchase APIs
router.get('/user/list', getUserPlans);
router.post('/user/create-order', protect, createPlanPurchaseOrder);
router.post('/user/verify-payment', protect, verifyPlanPurchasePayment);
router.post('/user/purchase', protect, purchasePlan);
router.get('/user/my-purchases', protect, getMyPlanPurchases);
router.get('/user/current-plan', protect, getMyCurrentPlan);
router.get('/user/:id', protect, getUserPlanById);

// Doctor-facing routes
router.get('/doctor/patient-plan', protectDoctor, getDoctorPatientCurrentPlan);

// Legacy endpoints kept for backward compatibility
router.post('/add', AppAdminprotect, createPlan);
router.get('/getAllPlan', AppAdminprotect, getAdminPlans);
router.get('/getById/:id', AppAdminprotect, getAdminPlanById);
router.put('/update/:id', AppAdminprotect, updatePlan);
router.delete('/delete/:id', AppAdminprotect, deletePlan);
router.patch('/statusUpdate/:id', AppAdminprotect, planStatusUpdate);

export default router;  