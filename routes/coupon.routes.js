import express from 'express';
import { 
    createCoupon,
    getAllCoupons,
    updateCoupon,
    deleteCoupon
} from '../controllers/coupon.Controller.js';
import { AppAdminprotect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/create', AppAdminprotect, createCoupon);
router.get('/get', getAllCoupons);
// router.post('/apply', applyCoupon);
router.patch('/updatecoupons/:id',AppAdminprotect, updateCoupon);
router.delete('/deletecoupons/:id', AppAdminprotect, deleteCoupon);

export default router;