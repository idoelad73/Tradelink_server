import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import router from './routes/index.js';
import { handleWebhook } from './routes/stripe.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

// ── Stripe webhook — MUST be registered with express.raw() BEFORE express.json()
// Stripe sends a raw Buffer; express.json() would corrupt it and break signature
// verification (rule #5). This single route is the exception to the json middleware.
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  handleWebhook
);

// ── Global middleware ─────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin.startsWith('http://localhost:') || origin === process.env.CLIENT_URL || origin === 'https://trade-link-client-dev.onrender.com') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan('dev'));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api', router);

// ── Error handler (must be last) ─────────────────────────────────────────────
app.use(errorHandler);

export default app;
