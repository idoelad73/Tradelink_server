import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import { documentUpload, handleUploadError } from '../middleware/upload.js';
import { getOrCreateChat, getTradeChat, uploadChatFile } from '../controllers/chatController.js';

const router = Router();

router.use(protect);

router.post('/upload',                           documentUpload.single('file'), handleUploadError, uploadChatFile);
router.get('/trade/:siteId',                     getTradeChat);
router.get('/:contractorId/:tradeProId/:siteId', getOrCreateChat);

export default router;
