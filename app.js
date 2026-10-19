import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import router from './routes/index.js';
import { handleWebhook } from './routes/stripe.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

// Behind Render's reverse proxy — trust exactly one hop so `req.ip` is the real
// client address. Required for the auth rate limiters to key per client rather
// than per proxy (and for any X-Forwarded-For reads).
app.set('trust proxy', 1);

// ── Stripe webhook — MUST be registered with express.raw() BEFORE express.json()
// Stripe sends a raw Buffer; express.json() would corrupt it and break signature
// verification (rule #5). This single route is the exception to the json middleware.
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  handleWebhook
);

// ── CORS ────────────────────────────────────────────────────────────────────
// Exact-match allow-list. An Origin header carries only scheme+host[+port] —
// never a path or trailing slash — so entries are bare origins. The previous
// check ended in `|| 'https://…/'`, a truthy string constant that made the whole
// condition always-true and allowed EVERY origin with credentials (finding #1).
const ALLOWED_ORIGINS = [
  'https://trade-link-client-dev.onrender.com',
  'https://tradelink-dashbpard.onrender.com', // deployed dashboard host (spelling matches the real deploy)
  process.env.CLIENT_URL,
].filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true;                             // same-origin, curl, server-to-server
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return true; // local dev, any port
  return ALLOWED_ORIGINS.includes(origin);
}

// ── Global middleware ─────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// Request logging only outside production. `morgan('dev')` logs the full URL,
// which for GET links carrying a `?token=` (e.g. email actions) would write that
// token to the logs (finding #6). Keep it for local/dev visibility only.
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api', router);

// ── Error handler (must be last) ─────────────────────────────────────────────
app.use(errorHandler);

export default app;
