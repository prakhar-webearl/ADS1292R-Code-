import express from 'express';
import {
    testCreate,
    updateTest,
    getAllTest,
    getTestById,
    deleteTest,
} from '../controllers/test.Controller.js';
import testupload from '../middleware/testmulter.js';
import { AppAdminprotect } from '../middleware/authMiddleware.js'
const router = express.Router();

router.post ('/testCreate', testupload.single('photo'), AppAdminprotect, testCreate)
router.put ('/updateTest/:id', testupload.single('photo'), AppAdminprotect, updateTest);
router.get ('/getAllTest', AppAdminprotect, getAllTest);
router.get ('/getTest/:id', AppAdminprotect, getTestById);
router.delete ('/deleteTest/:id', AppAdminprotect, deleteTest);

export default router;