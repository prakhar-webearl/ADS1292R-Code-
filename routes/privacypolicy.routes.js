import express from 'express';
import {
    createPrivacyPolicy,
    getAllPrivacyPolicy,
    getPrivacyPolicyById,
    getLatestPrivacyPolicy,
    updatePrivacyPolicy,
    deletePrivacyPolicy
} from '../controllers/privacyPolicy.Controller.js';
import { AppAdminprotect } from '../middleware/authMiddleware.js'

const router = express.Router();

router.get('/public', getLatestPrivacyPolicy);

router.post('/create', AppAdminprotect, createPrivacyPolicy);
router.get('/getAll', AppAdminprotect, getAllPrivacyPolicy);
router.get('/getById/:id', AppAdminprotect, getPrivacyPolicyById );
router.put('/update/:id', AppAdminprotect, updatePrivacyPolicy);
router.delete('/delete/:id', AppAdminprotect, deletePrivacyPolicy);

export default router;