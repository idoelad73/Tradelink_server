import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../app.js';
import Contractor from '../../models/Contractor.js';
import TradePro from '../../models/TradePro.js';

/**
 * The sign-up checkbox is only worth anything if the acceptance is recorded.
 * The client sends which version it displayed; the timestamp is stamped
 * server-side so it can't be forged by the client.
 */

const contractorBody = (over = {}) => ({
  companyName: 'Smith Construction LLC',
  email:       `c${Date.now()}${Math.random().toString(36).slice(2)}@test.local`,
  password:    'Abcdefg!',   // policy-compliant: exactly 8, upper+lower+symbol
  phone:       '5550100',
  address:     '1 Main St, New York, NY',
  expertise:   JSON.stringify(['Residential Construction']),
  ...over,
});

describe('Terms acceptance — contractor registration', () => {
  it('records the version and a server-side timestamp', async () => {
    const body = contractorBody({ termsVersion: '2026-10-18' });
    const before = Date.now();

    const res = await request(app).post('/api/auth/register/contractor').send(body);
    expect(res.status).toBe(201);

    const saved = await Contractor.findOne({ email: body.email }).lean();
    expect(saved.termsVersion).toBe('2026-10-18');
    expect(saved.termsAcceptedAt).toBeInstanceOf(Date);
    expect(saved.termsAcceptedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('ignores a client-supplied timestamp and stamps its own', async () => {
    const forged = new Date('2001-01-01T00:00:00Z').toISOString();
    const body = contractorBody({ termsVersion: '2026-10-18', termsAcceptedAt: forged });

    await request(app).post('/api/auth/register/contractor').send(body);

    const saved = await Contractor.findOne({ email: body.email }).lean();
    expect(saved.termsAcceptedAt.getFullYear()).not.toBe(2001);
  });

  it('leaves both fields null when no version is sent', async () => {
    const body = contractorBody();
    await request(app).post('/api/auth/register/contractor').send(body);

    const saved = await Contractor.findOne({ email: body.email }).lean();
    expect(saved.termsVersion).toBeNull();
    expect(saved.termsAcceptedAt).toBeNull();
  });
});

describe('Terms acceptance — trade registration', () => {
  it('records the version and a server-side timestamp', async () => {
    const email = `t${Date.now()}${Math.random().toString(36).slice(2)}@test.local`;

    const res = await request(app)
      .post('/api/auth/register/trade')
      .field('fullName',        'Pat Tradesman')
      .field('email',           email)
      .field('password',        'Abcdefg!')
      .field('phone',           '5550200')
      .field('address',         '2 Main St, New York, NY')
      .field('professionality', 'Painter')
      .field('termsVersion',    '2026-10-18');

    expect(res.status).toBe(201);

    const saved = await TradePro.findOne({ email }).lean();
    expect(saved.termsVersion).toBe('2026-10-18');
    expect(saved.termsAcceptedAt).toBeInstanceOf(Date);
  });
});
