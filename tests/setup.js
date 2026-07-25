import { beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { stripeMock, resetStripeMock } from './mocks/stripe.js';

// ── Environment ───────────────────────────────────────────────────────────────
// app.js and the controllers read process.env at import time, and nothing in the
// test path loads dotenv. Set these BEFORE any application module is imported so
// no test can accidentally pick up the developer's real .env — in particular a
// live Stripe key or a real Mongo URI.
process.env.NODE_ENV                    = 'test';
process.env.JWT_SECRET                  = 'test-jwt-secret';
process.env.STRIPE_SECRET_KEY           = 'sk_test_fake';
process.env.STRIPE_PLATFORM_FEE_PERCENT = '10';
process.env.RESEND_API_KEY              = 're_test_fake';
process.env.RESEND_FROM_EMAIL           = 'TradeLink <test@example.com>';
process.env.CLIENT_URL                  = 'http://localhost:5173';

// ── Module mocks ──────────────────────────────────────────────────────────────
// Everything that reaches the network is replaced. Paths resolve relative to
// this file.
vi.mock('../utils/stripe.js', () => ({ default: stripeMock }));

export const sendMail = vi.fn(async () => ({ id: 'email_test' }));
vi.mock('../utils/mailer.js', () => ({ sendMail }));

vi.mock('../utils/cloudinary.js', () => ({
  uploadPhoto:          vi.fn(async () => 'https://cdn.test/photo.jpg'),
  uploadDocument:       vi.fn(async () => 'https://cdn.test/doc.pdf'),
  uploadToCloudinary:   vi.fn(async () => 'https://cdn.test/file'),
  uploadChatFile:       vi.fn(async () => 'https://cdn.test/chat-file'),
  deleteFromCloudinary: vi.fn(async () => ({ result: 'ok' })),
}));

vi.mock('../utils/geocode.js', () => ({
  geocodeAddress: vi.fn(async () => ({ lat: '40.7128', lng: '-74.0060' })),
}));

// PDFKit generation is slow and irrelevant to the assertions — the tests care
// that a receipt was attached, not what it renders to.
vi.mock('../email_templates/receiptPdf.js', () => ({
  contractorReceiptPdf: vi.fn(async () => Buffer.from('%PDF-contractor')),
  tradeReceiptPdf:      vi.fn(async () => Buffer.from('%PDF-trade')),
}));

// ── In-memory MongoDB ─────────────────────────────────────────────────────────
let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'tradelink-test' });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  // Wipe documents rather than dropping the database — dropping would also drop
  // the indexes Mongoose built on connect, and the Message model relies on a
  // partial unique index that would silently stop being enforced.
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map(c => c.deleteMany({})));

  sendMail.mockClear();
  resetStripeMock();
});
