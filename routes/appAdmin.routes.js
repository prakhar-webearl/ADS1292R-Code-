import express from 'express';
import { 
    // appAdminSignUp,
    appAdminSignIn,
    getappAdminProfile,
    updateappAdminProfile,
    appAdminchangePassword,
    getAllUser,
    getUserById,
    userStatusUpdate,
    getUserWithFamilyById,
    deleteUser
    // appAdmindeleteUserProfile
} from '../controllers/appAdmin.Controller.js';
import { getConsultancyDetailsById } from '../controllers/consultancy.Controller.js';
import { AppAdminprotect } from '../middleware/authMiddleware.js';

const router = express.Router();

// router.post('/register', appAdminSignUp);
router.post('/login', appAdminSignIn);
router.get('/getadminprofile', AppAdminprotect, getappAdminProfile);
router.put('/updateprofile', AppAdminprotect, updateappAdminProfile);
router.put('/changepassword', AppAdminprotect, appAdminchangePassword);
router.get('/getAllUser', AppAdminprotect, getAllUser);
router.get('/getUserById/:id', AppAdminprotect, getUserById);
router.patch('/userStatus/:id', AppAdminprotect, userStatusUpdate);
router.get('/user-with-family/:id', AppAdminprotect, getUserWithFamilyById);
router.get('/consultancy/details/:consultancyId', AppAdminprotect, getConsultancyDetailsById);
router.delete('/deleteUser/:id', AppAdminprotect, deleteUser);
// router.delete('/deleteprofile', AppAdminprotect, appAdmindeleteUserProfile);

export default router;