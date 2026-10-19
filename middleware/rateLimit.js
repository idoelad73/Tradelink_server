import rateLimit from 'express-rate-limit';

// Rate limiters for the authentication surface (QA finding #2: login, register
// and password-reset had no throttling, leaving them open to brute force,
// credential stuffing and password-reset email bombing).
//
// Hard dependency on purpose: if express-rate-limit is ever missing, boot should
// FAIL rather than silently serve these endpoints unprotected. Keyed on client
// IP — see `app.set('trust proxy', 1)` in app.js so the key is the real client
// behind Render's proxy, not the proxy itself.
//
// Skipped under NODE_ENV=test so the integration suite isn't throttled; the
// limiter is infrastructure behaviour, not business logic under test.
const base = {
  standardHeaders: true,   // RateLimit-* headers
  legacyHeaders:   false,  // no X-RateLimit-*
  skip: () => process.env.NODE_ENV === 'test',
};

// Login + registration: stop credential stuffing / account-spam without locking
// a real user out over a couple of typos.
export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit:    10,
  message:  { success: false, message: 'Too many attempts — please try again in a few minutes.' },
});

// Forgot / reset password: stricter. Each forgot-password sends a real email, so
// this also caps reset-link flooding and inbox bombing of a target address.
export const passwordResetLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000, // 1 hour
  limit:    5,
  message:  { success: false, message: 'Too many password-reset requests — please try again later.' },
});
