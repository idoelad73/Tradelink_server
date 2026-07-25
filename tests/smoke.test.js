import { describe, it, expect } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../app.js';
import { createContractor } from './helpers/factories.js';

// Proves the harness itself works: the Express app boots without a real Mongo,
// Stripe or Resend, requests reach the router, and the in-memory DB round-trips.
describe('test harness', () => {
  it('serves GET /api/health', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('is connected to the in-memory MongoDB', () => {
    expect(mongoose.connection.readyState).toBe(1);
    expect(mongoose.connection.host).toBe('127.0.0.1');
  });

  it('persists and reads back a document', async () => {
    const contractor = await createContractor({ companyName: 'Smoke Co' });
    const found      = await mongoose.model('Contractor').findById(contractor._id).lean();
    expect(found.companyName).toBe('Smoke Co');
  });
});
