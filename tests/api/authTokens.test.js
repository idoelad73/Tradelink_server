import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../app.js';
import Contractor from '../../models/Contractor.js';
import { createContractor, TEST_PASSWORD } from '../helpers/factories.js';

const login = (email, password = TEST_PASSWORD) =>
  request(app).post('/api/auth/login/contractor').send({ email, password });

// supertest doesn't keep a cookie jar — pull set-cookie and replay it.
const cookiesFrom = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]);
const refreshCookie = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('refreshToken='));

describe('access + refresh tokens', () => {
  it('login returns a short-lived access token and an httpOnly refresh cookie', async () => {
    const c = await createContractor({ email: 'tok@test.local' });
    const res = await login('tok@test.local').expect(200);

    // Access token in the body, ~2h life.
    expect(res.body.token).toBeTruthy();
    const { iat, exp, type, id } = jwt.decode(res.body.token);
    expect(type).toBe('contractor');
    expect(String(id)).toBe(String(c._id));
    expect(exp - iat).toBe(2 * 60 * 60);

    // Refresh token: httpOnly cookie, never in the body.
    const cookie = refreshCookie(res);
    expect(cookie).toBeTruthy();
    expect(cookie.toLowerCase()).toContain('httponly');
    expect(res.body.refreshToken).toBeUndefined();
    expect(res.body.token).not.toBe(cookie.split('=')[1].split(';')[0]); // distinct values

    // Hash stored, raw never persisted.
    const saved = await Contractor.findById(c._id).select('+refreshTokenHash').lean();
    expect(saved.refreshTokenHash).toBeTruthy();
    expect(cookie).not.toContain(saved.refreshTokenHash);
  });

  it('the access token actually authenticates a protected route', async () => {
    await createContractor({ email: 'tok2@test.local' });
    const res = await login('tok2@test.local').expect(200);
    const me = await request(app).get('/api/contractor/me')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
  });

  describe('POST /api/auth/refresh', () => {
    it('exchanges the cookie for a fresh access token', async () => {
      await createContractor({ email: 'rf@test.local' });
      const res = await login('rf@test.local').expect(200);

      const refreshed = await request(app).post('/api/auth/refresh')
        .set('Cookie', cookiesFrom(res)).expect(200);

      expect(refreshed.body.token).toBeTruthy();
      expect(jwt.decode(refreshed.body.token).type).toBe('contractor');
      expect(refreshCookie(refreshed)).toBeTruthy(); // a rotated cookie is set
    });

    it('rotates the refresh token — the previous cookie stops working', async () => {
      await createContractor({ email: 'rot@test.local' });
      const res = await login('rot@test.local').expect(200);
      const firstCookie = cookiesFrom(res);

      const r1 = await request(app).post('/api/auth/refresh').set('Cookie', firstCookie).expect(200);
      // Reusing the original (now-rotated) cookie must fail.
      const reuse = await request(app).post('/api/auth/refresh').set('Cookie', firstCookie);
      expect(reuse.status).toBe(401);
      // The rotated cookie from r1 still works.
      await request(app).post('/api/auth/refresh').set('Cookie', cookiesFrom(r1)).expect(200);
    });

    it('401s without a refresh cookie', async () => {
      await request(app).post('/api/auth/refresh').expect(401);
    });

    it('401s for a forged/unknown refresh cookie', async () => {
      await request(app).post('/api/auth/refresh')
        .set('Cookie', ['refreshToken=deadbeefdeadbeef']).expect(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('revokes the session — the refresh token no longer works', async () => {
      const c = await createContractor({ email: 'lo@test.local' });
      const res = await login('lo@test.local').expect(200);
      const cookie = cookiesFrom(res);

      await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(200);

      // Server-side hash cleared, and the cookie can no longer be refreshed.
      const saved = await Contractor.findById(c._id).select('+refreshTokenHash').lean();
      expect(saved.refreshTokenHash).toBeNull();
      await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(401);
    });

    it('is safe to call with no session', async () => {
      await request(app).post('/api/auth/logout').expect(200);
    });
  });

  it('a password reset revokes the existing session', async () => {
    const c = await createContractor({ email: 'pwr@test.local' });
    const res = await login('pwr@test.local').expect(200);
    const cookie = cookiesFrom(res);

    // Drive a reset through the real endpoints.
    const crypto = await import('crypto');
    const raw  = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await Contractor.findByIdAndUpdate(c._id, {
      passwordResetTokenHash: hash,
      passwordResetExpiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post('/api/auth/reset-password')
      .send({ token: raw, password: 'Abcdefg!' }).expect(200);

    // The pre-reset refresh token is now dead.
    await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(401);
  });
});
