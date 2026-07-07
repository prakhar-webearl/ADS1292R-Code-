import express from 'express';
import {
    createHelp,
    getAllHelp,
    getHelpById,
    updateHelp,
    deleteHelp
} from '../controllers/help.Controller.js';
import { AppAdminprotect } from '../middleware/authMiddleware.js'

const router = express.Router();

router.post('/create', AppAdminprotect, createHelp);
router.get('/getAll', AppAdminprotect, getAllHelp);
router.get('/getById/:id', AppAdminprotect, getHelpById );
router.put('/update/:id', AppAdminprotect, updateHelp);
router.delete('/delete/:id', AppAdminprotect, deleteHelp);


export default router;