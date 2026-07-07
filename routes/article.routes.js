import express from 'express';
import multer from 'multer';
import { 
    createArticle,
    getAllArticles,
    getArticleById,
    updateArticle,
    deleteArticle,
    getHomeTopBlogs,
} from '../controllers/article.Controller.js';
import { AppAdminprotect } from '../middleware/authMiddleware.js';
import articleupload  from '../middleware/articlemulter.js'

const router = express.Router();

const articlePhotoUpload = (req, res, next) => {
    articleupload.single('photo')(req, res, (error) => {
        if (!error) {
            return next();
        }

        console.error('[article upload] Multer error:', {
            message: error.message,
            name: error.name,
            code: error.code,
            route: req.originalUrl,
        });

        if (error instanceof multer.MulterError) {
            const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
            return res.status(status).json({
                success: false,
                message: `Upload error: ${error.message}`,
                code: error.code,
            });
        }

        return res.status(400).json({
            success: false,
            message: error.message || 'Invalid file upload',
        });
    });
};

// Home/blog listing endpoint for app home screen
router.get('/home/top', getHomeTopBlogs);

router.post('/create', AppAdminprotect, articlePhotoUpload, createArticle);
router.get('/getall', AppAdminprotect, getAllArticles);
router.get('/getById/:id', AppAdminprotect, getArticleById);
router.put('/update/:id', AppAdminprotect, articlePhotoUpload, updateArticle)
router.delete('/delete/:id', AppAdminprotect, deleteArticle);

export default router;