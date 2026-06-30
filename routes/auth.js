import { Router } from 'express';
import { registerTrade, registerContractor, loginTrade, loginContractor, forgotPassword, resetPassword } from '../controllers/authController.js';
import { tradeRegistrationUpload, handleUploadError } from '../middleware/upload.js';

const router = Router();

// Trade sub-contractor — multipart: photo (image) + 3 document fields
router.post(
  '/register/trade',
  tradeRegistrationUpload,
  handleUploadError,
  registerTrade
);

// Building contractor — JSON body only, no file uploads
router.post('/register/contractor', registerContractor);

// Login routes — JSON body
router.post('/login/trade',       loginTrade);
router.post('/login/contractor',  loginContractor);

// Password reset
router.post('/forgot-password', forgotPassword);
router.post('/reset-password',  resetPassword);

export default router;
