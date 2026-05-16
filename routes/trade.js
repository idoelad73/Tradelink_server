import { Router } from 'express';
import { protect, restrictTo } from '../middleware/auth.js';
import { getMe, updateMe, updateSchedule } from '../controllers/tradeController.js';

const router = Router();

router.use(protect, restrictTo('trade'));

router.get('/me',       getMe);
router.patch('/me',     updateMe);
router.patch('/schedule', updateSchedule);

export default router;
