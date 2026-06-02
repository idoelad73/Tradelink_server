import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import router from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

// ── Middleware ────────────────────────────────────────────
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

// ── Routes ────────────────────────────────────────────────
app.use('/api', router);

// ── Error handler (must be last) ─────────────────────────
app.use(errorHandler);

export default app;
