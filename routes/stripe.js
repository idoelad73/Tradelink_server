import { Router }              from 'express';
import { protect, restrictTo } from '../middleware/auth.js';
import { createPaymentIntent, createDepositIntent, handleWebhook } from '../controllers/stripeController.js';

const router = Router();

// ── Webhook — raw body, NO auth (Stripe calls this directly) ─────────────────
// Registered in app.js with express.raw() BEFORE express.json() (rule #5).
// This route entry is just a placeholder — the real handler lives in app.js.
// We export it here so app.js can import it cleanly.

// ── Rate limiter — 10 payment attempts per IP per 15 min (rule #9) ───────────
// express-rate-limit is optional at boot — falls back to a no-op until installed.
// Run: npm install express-rate-limit   (in server/)
let paymentLimiter = (_req, _res, next) => next(); // no-op fallback
try {
  const { default: rateLimit } = await import('express-rate-limit');
  paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max:      10,
    message:  { message: 'Too many payment attempts — please try again later' },
    standardHeaders: true,
    legacyHeaders:   false,
  });
} catch {
  console.warn('[stripe routes] express-rate-limit not installed — rate limiting disabled. Run: npm install express-rate-limit');
}

// ── Authenticated contractor routes ──────────────────────────────────────────
router.use(protect, restrictTo('contractor'));

router.post('/create-payment-intent',  paymentLimiter, createPaymentIntent);
router.post('/create-deposit-intent',  paymentLimiter, createDepositIntent);

export { handleWebhook };
export default router;
