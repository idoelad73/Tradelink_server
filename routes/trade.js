import { Router } from 'express';
import { protect, restrictTo } from '../middleware/auth.js';
import { photoUpload, handleUploadError } from '../middleware/upload.js';
import { getMe, updateMe, updateSchedule, updateLocation, approveBooking } from '../controllers/tradeController.js';

const router = Router();

// Public — no auth (clicked from email link)
router.get('/approve-booking', approveBooking);

// All routes below require a valid JWT for a trade account
router.use(protect, restrictTo('trade'));

router.get('/me',          getMe);
router.patch('/me',        photoUpload.single('photo'), handleUploadError, updateMe);
router.patch('/schedule',  updateSchedule);
router.patch('/location',  updateLocation);

export default router;
