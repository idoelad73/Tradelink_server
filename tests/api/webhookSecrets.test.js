import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../../app.js';
import stripeMock from '../mocks/stripe.js';

/**
 * Live mode has two Stripe webhook endpoints pointing at /api/stripe/webhook —
 * "Your account" events and "Connected accounts" events — each signed with its
 * own secret. The handler must accept an event that verifies against either.
 */

const EVENT = { type: 'payment_intent.created', data: { object: { id: 'pi_x', metadata: {} } } };

// Fake verification: only the secret named `good` succeeds
function onlySecret(good) {
  stripeMock.webhooks.constructEvent.mockImplementation((_body, _sig, secret) => {
    if (secret !== good) throw new Error('No signatures found matching the expected signature');
    return EVENT;
  });
}

const post = () => request(app)
  .post('/api/stripe/webhook')
  .set('stripe-signature', 'sig_test')
  .set('Content-Type', 'application/json')
  .send(Buffer.from('{}'));

describe('Stripe webhook — platform + Connect signing secrets', () => {
  afterEach(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  });

  it('accepts an event signed with the platform secret', async () => {
    process.env.STRIPE_WEBHOOK_SECRET         = 'whsec_platform';
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
    onlySecret('whsec_platform');
    await post().expect(200);
  });

  it('accepts an event signed with the Connect secret', async () => {
    process.env.STRIPE_WEBHOOK_SECRET         = 'whsec_platform';
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
    onlySecret('whsec_connect');
    await post().expect(200);
  });

  it('rejects an event that matches neither secret', async () => {
    process.env.STRIPE_WEBHOOK_SECRET         = 'whsec_platform';
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
    onlySecret('whsec_someone_else');
    const res = await post().expect(400);
    expect(res.text).toMatch(/Webhook Error/);
  });
});
