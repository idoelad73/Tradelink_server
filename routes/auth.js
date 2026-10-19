import { Router } from 'express';
import { registerTrade, registerContractor, loginTrade, loginContractor, loginAdmin, forgotPassword, resetPassword, refreshToken, logout } from '../controllers/authController.js';
import { tradeRegistrationUpload, handleUploadError } from '../middleware/upload.js';
import { authLimiter, passwordResetLimiter } from '../middleware/rateLimit.js';

const router = Router();

// Trade sub-contractor — multipart: photo (image) + 3 document fields
router.post(
  '/register/trade',
  authLimiter,
  tradeRegistrationUpload,
  handleUploadError,
  registerTrade
);

// Building contractor — JSON body only, no file uploads
router.post('/register/contractor', authLimiter, registerContractor);

// Login routes — JSON body
router.post('/login/trade',       authLimiter, loginTrade);
router.post('/login/contractor',  authLimiter, loginContractor);
router.post('/login/admin',       authLimiter, loginAdmin);

// Password reset — stricter limit; forgot-password also sends a real email.
router.post('/forgot-password', passwordResetLimiter, forgotPassword);
router.post('/reset-password',  passwordResetLimiter, resetPassword);

// Session lifecycle — exchange the httpOnly refresh cookie for a new access
// token, and revoke it on logout.
router.post('/refresh', refreshToken);
router.post('/logout',  logout);

export default router;
