import express from 'express';
import { 
    applyCoupon,
    getAppliedCoupons
} from '../controllers/appliedCoupon.Controller.js';

import { protect } from "../middleware/authMiddleware.js"

const router = express.Router();

router.post('/apply', protect, applyCoupon);
router.get('/', protect, getAppliedCoupons);

export default router;