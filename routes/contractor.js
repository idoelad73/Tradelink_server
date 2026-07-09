import { Router } from 'express';
import multer from 'multer';
import { protect, restrictTo } from '../middleware/auth.js';
import {
  getMe, updateMe,
  createSite, getSites, getSite, updateSite, deleteSite, findTrades,
  getTradeBusyDays, getTradeProProfile, askAvailability, getWorkersLeft,
  getApplications, approveApplication, approveAvailabilityRequest, approveWorkerOffer,
  getNotifications, markNotificationsRead,
  getWorkPlan, updateWorkPlanDate, deleteWorkPlanTrade, requestWorkPlanDate,
  approveReschedule, declineReschedule,
  getMyOrders, getMyReceipts,
  getPaymentApprovalsCount, getPaymentApprovals, updatePaymentApproval,
  getGradableTrades, submitTradeGrade, uploadGradePhoto, getTradeReviews,
  getSiteDepositSummary, confirmDeposit, getPendingDeposits,
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
router.get('/applications',                        getApplications);
router.patch('/applications/:id/approve',          approveApplication);
router.patch('/messages/:id/approve-reschedule',   approveReschedule);
router.patch('/messages/:id/decline-reschedule',   declineReschedule);
router.patch('/messages/:id/approve-availability', approveAvailabilityRequest);
router.patch('/messages/:id/approve-worker-offer', approveWorkerOffer);

// Availability-approved notifications
router.get('/notifications',       getNotifications);
router.patch('/notifications/read', markNotificationsRead);

// Orders / receipts
router.get('/receipts', getMyReceipts);
router.get('/orders',   getMyOrders);

// Payment approvals (tradehours_orders)
router.get('/payment-approvals/count',       getPaymentApprovalsCount);
router.get('/payment-approvals',             getPaymentApprovals);
router.patch('/payment-approvals/:orderId',  updatePaymentApproval);

// Trade grading
router.get('/trade-grades/eligible',          getGradableTrades);
router.get('/trade-grades/:tradeId/reviews',  getTradeReviews);
router.post('/trade-grades/photo',            upload.single('photo'), uploadGradePhoto);
router.post('/trade-grades',                  submitTradeGrade);

// Sites — full CRUD
router.post('/sites',       upload.single('photo'), createSite);
router.get('/sites',        getSites);
router.get('/trade-pros/:tradeId/busy-days',         getTradeBusyDays);
router.get('/trade-pros/:tradeId/profile',           getTradeProProfile);
router.post('/trade-pros/:tradeId/ask-availability', askAvailability);
router.get('/sites/:siteId/workers-left',            getWorkersLeft);
router.get('/sites/:siteId/deposit-summary',         getSiteDepositSummary);
router.get('/pending-deposits',                      getPendingDeposits);
router.post('/deposit-confirmed',                    confirmDeposit);
router.get('/sites/:id',              getSite);
router.get('/sites/:id/work-plan',            getWorkPlan);
router.post('/sites/:id/work-plan/request-date', requestWorkPlanDate);
router.patch('/sites/:id/work-plan',          updateWorkPlanDate);
router.delete('/sites/:id/work-plan',         deleteWorkPlanTrade);
router.get('/sites/:id/find-trades',  findTrades);
router.patch('/sites/:id',            upload.single('photo'), updateSite);
router.delete('/sites/:id',           deleteSite);

export default router;
