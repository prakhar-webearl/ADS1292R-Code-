import express from 'express';
import {
    createTermsCondition,
    getAllTermsCondition,
    getTermsConditionById,
    getLatestTermsCondition,
    updateTermsCondition,
    deleteTermsCondition
} from '../controllers/termsCondition.Controller.js';
import { AppAdminprotect } from '../middleware/authMiddleware.js'

const router = express.Router();

router.get('/public', getLatestTermsCondition);

router.post('/create', AppAdminprotect, createTermsCondition);
router.get('/getAll', AppAdminprotect, getAllTermsCondition);
router.get('/getById/:id', AppAdminprotect, getTermsConditionById );
router.put('/update/:id', AppAdminprotect, updateTermsCondition);
router.delete('/delete/:id', AppAdminprotect, deleteTermsCondition);

export default router;