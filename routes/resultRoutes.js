import express from 'express';
import { storeAiResult, streamLiveResults } from '../controllers/resultController.js';

const router = express.Router();

router.post('/', storeAiResult);
router.get('/live/:deviceId', streamLiveResults);

export default router;
