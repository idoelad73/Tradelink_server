import { Router } from 'express';
import multer from 'multer';
import { protect, restrictTo } from '../middleware/auth.js';
import {
  getMe, updateMe,
  createSite, getSites, getSite, updateSite, deleteSite, findTrades,
  getTradeBusyDays, askAvailability,
  getApplications, approveApplication,
} from '../controllers/contractorController.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

const router = Router();

// All contractor routes require a valid JWT for a contractor account
router.use(protect, restrictTo('contractor'));

// Profile
router.get('/me',   getMe);
router.patch('/me', updateMe);

// Applications (trade pros applying to contractor sites)
router.get('/applications',              getApplications);
router.patch('/applications/:id/approve', approveApplication);

// Sites — full CRUD
router.post('/sites',       upload.single('photo'), createSite);
router.get('/sites',        getSites);
router.get('/trade-pros/:tradeId/busy-days',         getTradeBusyDays);
router.post('/trade-pros/:tradeId/ask-availability', askAvailability);
router.get('/sites/:id',              getSite);
router.get('/sites/:id/find-trades',  findTrades);
router.patch('/sites/:id',            upload.single('photo'), updateSite);
router.delete('/sites/:id',           deleteSite);

export default router;
