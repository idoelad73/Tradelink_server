import { Router } from 'express';
import { protect, restrictTo } from '../middleware/auth.js';
import { photoUpload, handleUploadError } from '../middleware/upload.js';
import { getMe, updateMe, updateSchedule, updateLocation, approveBooking, getMessages, approveMessage, findJobs, applyToJob, requestReschedule, removeBooking, getMyOrders, getMyReceipts, getApprovedOrderDates, checkWorkLog, submitWorkLog, getPaymentApprovedCount, getPaymentApproved, getGradableContractors, uploadContractorGradePhoto, submitContractorGrade, getContractorReviews } from '../controllers/tradeController.js';
import { createOnboardingLink, completeOnboarding, getStripeStatus } from '../controllers/tradeStripeController.js';

const router = Router();

// Public — no auth (clicked from email link)
router.get('/approve-booking', approveBooking);

// All routes below require a valid JWT for a trade account
router.use(protect, restrictTo('trade'));

router.get('/me',          getMe);
router.get('/find-jobs',              findJobs);
router.post('/jobs/:siteId/apply',    applyToJob);
router.get('/messages',               getMessages);
router.patch('/messages/:id/approve', approveMessage);
router.patch('/me',        photoUpload.single('photo'), handleUploadError, updateMe);
router.patch('/schedule',   updateSchedule);
router.patch('/location',   updateLocation);
router.post('/reschedule',  requestReschedule);
router.delete('/bookings',  removeBooking);
router.get('/receipts',         getMyReceipts);
router.get('/orders',           getMyOrders);
router.get('/approved-orders',  getApprovedOrderDates);
router.get('/work-log/check',   checkWorkLog);
router.post('/work-log',      submitWorkLog);
router.get('/payment-approved/count', getPaymentApprovedCount);
router.get('/payment-approved',       getPaymentApproved);

// ── Contractor grading (by trade pros) ──────────────────────────────────────
import multer from 'multer';
const gradeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (_r, f, cb) => cb(null, f.mimetype.startsWith('image/')) });
router.get ('/contractor-grades/eligible',              getGradableContractors);
router.post('/contractor-grades/photo',                gradeUpload.single('photo'), uploadContractorGradePhoto);
router.post('/contractor-grades',                      submitContractorGrade);
router.get ('/contractor-grades/:contractorId/reviews', getContractorReviews);

// ── Stripe Connect onboarding ────────────────────────────────────────────────
router.get ('/stripe/status',            getStripeStatus);
router.post('/stripe/onboard',           createOnboardingLink);
router.post('/stripe/onboard/complete',  completeOnboarding);

export default router;
