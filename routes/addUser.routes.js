import express from 'express';
import {
    addMember,
    updateFamilyMember,
    deleteFamilyMember,
    getAllFamilyMembers,
    getFamilyMemberById
} from '../controllers/addUser.Controller.js';
import { protect } from '../middleware/authMiddleware.js'; 

const router = express.Router();

router.post('/addMember', protect, addMember);
router.put('/family-member-update/:id', protect, updateFamilyMember);
router.delete('/family-member-delete/:id', protect, deleteFamilyMember);
router.get('/getall-family-members', protect, getAllFamilyMembers);
router.get('/getById-family-member/:id', protect, getFamilyMemberById);

export default router;