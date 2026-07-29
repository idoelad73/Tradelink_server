import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../app.js';
import { sendMail } from '../setup.js';
import { stripeWebhookEvent } from '../mocks/stripe.js';
import Receipt from '../../models/Receipt.js';
import WorkHoursOrder from '../../models/WorkHoursOrder.js';
import {
  createContractor, createTradePro, createSite, createWorkHoursOrder,
  asContractor, createPendingPaymentMessage, createDepositMessage,
} from '../helpers/factories.js';

const recipients = () => sendMail.mock.calls.map(([a]) => a.to);
const mailTo = (addr) => sendMail.mock.calls.map(([a]) => a).filter(a => a.to === addr);

async function paidOrder(overrides = {}) {
  const contractor = await createContractor();
  const tradePro   = await createTradePro();
  const site       = await createSite(contractor);
  const order = await createWorkHoursOrder({
    contractor, tradePro, site,
    order_sum: 400, receiptSent: false, ...overrides,
  });
  return { contractor, tradePro, site, order };
}

/** Fires payment_intent.succeeded carrying `orderId` in PI metadata. */
function fireSucceeded(orderId) {
  stripeWebhookEvent({
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_hook', amount: 40_000, metadata: { orderId: String(orderId) } } },
  });
  return request(app)
    .post('/api/stripe/webhook')
    .set('stripe-signature', 'sig_test')
    .set('Content-Type', 'application/json')
    .send(Buffer.from('{}'));
}

describe('R5 — the webhook issues the same receipts as the approval flow', () => {
  it('writes both ledger rows with sequential numbers', async () => {
    const { order } = await paidOrder();

    await fireSucceeded(order._id).expect(200);

    const receipts = await Receipt.find({}).sort({ receipt_type: 1 }).lean();
    expect(receipts).toHaveLength(2);
    expect(receipts.map(r => r.receipt_number)).toEqual(['C000001', 'T000001']);
    expect(receipts.map(r => r.receipt_type)).toEqual(['contractor', 'trade']);
    for (const r of receipts) {
      expect(String(r.order_id)).toBe(String(order._id));
      expect(r.paymentStatus).toBe('paid');
      expect(r.emailedAt).toBeInstanceOf(Date);
    }
  });

  it('emails the trade pro, not just the contractor', async () => {
    const { contractor, tradePro, order } = await paidOrder();

    await fireSucceeded(order._id).expect(200);

    expect(recipients()).toEqual([contractor.email, tradePro.email]);
  });

  it('attaches numbered PDFs instead of a constant filename', async () => {
    const { contractor, tradePro, order } = await paidOrder();

    await fireSucceeded(order._id).expect(200);

    expect(mailTo(contractor.email)[0].attachments[0].filename).toBe('TradeLink-Receipt-C000001.pdf');
    expect(mailTo(tradePro.email)[0].attachments[0].filename).toBe('TradeLink-Receipt-T000001.pdf');
    // The old path sent this for every contractor on every order.
    expect(sendMail.mock.calls.map(([a]) => a.attachments[0].filename))
      .not.toContain('TradeLink-Receipt.pdf');
  });

  it('records the split on both rows', async () => {
    const { order } = await paidOrder();

    await fireSucceeded(order._id).expect(200);

    // STRIPE_PLATFORM_FEE_PERCENT is 10 in the test env.
    const c = await Receipt.findOne({ receipt_type: 'contractor' }).lean();
    expect(c.order_sum).toBe(400);
    expect(c.fee_sum).toBe(40);
    expect(c.payment_sum).toBe(360);

    const updated = await WorkHoursOrder.findById(order._id).lean();
    expect(updated.paymentStatus).toBe('paid');
    expect(updated.fee_sum).toBe(40);
    expect(updated.payment_sum).toBe(360);
    expect(updated.receiptSent).toBe(true);
  });

  it('leaves receiptSent false when the contractor receipt cannot be delivered', async () => {
    const { contractor, tradePro, order } = await paidOrder();
    sendMail.mockImplementation(async ({ to }) => {
      if (to === contractor.email) throw new Error('Resend error: bounced');
      return { id: 'ok' };
    });

    await fireSucceeded(order._id).expect(200);

    expect((await WorkHoursOrder.findById(order._id).lean()).receiptSent).toBe(false);
    // The trade pro's receipt is unaffected, and the ledger records both outcomes.
    expect(recipients()).toContain(tradePro.email);
    expect((await Receipt.findOne({ receipt_type: 'contractor' }).lean()).deliveryError).toMatch(/bounced/);
    expect((await Receipt.findOne({ receipt_type: 'trade' }).lean()).emailedAt).toBeInstanceOf(Date);
  });
});

describe('R5 — receipts are issued once per order, whichever route gets there', () => {
  it('a repeated webhook does not issue a second set', async () => {
    const { order } = await paidOrder();

    await fireSucceeded(order._id).expect(200);
    await fireSucceeded(order._id).expect(200);

    expect(await Receipt.countDocuments({})).toBe(2);
    expect(recipients()).toHaveLength(2);
  });

  it('a webhook after a failed delivery still does not duplicate the ledger', async () => {
    // receiptSent stays false when delivery fails, so the old `receiptSent`
    // guard alone would have let the retry through and burned four numbers.
    const { order } = await paidOrder();
    sendMail.mockRejectedValue(new Error('Resend down'));
    await fireSucceeded(order._id).expect(200);

    sendMail.mockReset().mockResolvedValue({ id: 'ok' });
    await fireSucceeded(order._id).expect(200);

    expect(await Receipt.countDocuments({})).toBe(2);
    expect((await Receipt.find({}).lean()).map(r => r.receipt_number).sort())
      .toEqual(['C000001', 'T000001']);
  });

  it('does not re-issue for an order the approval flow already receipted', async () => {
    const contractor = await createContractor();
    const tradePro   = await createTradePro();
    const site       = await createSite(contractor);
    await createDepositMessage({ contractor, tradePro, site, minDeposit: 10_000 });
    const pending = await createPendingPaymentMessage({ contractor, tradePro, site });

    await request(app)
      .patch(`/api/contractor/payment-approvals/${pending._id}`)
      .set(asContractor(contractor))
      .send({ status: 'approved' })
      .expect(200);

    expect(await Receipt.countDocuments({})).toBe(2);
    const order = await WorkHoursOrder.findOne({}).lean();

    sendMail.mockClear();
    await fireSucceeded(order._id).expect(200);

    expect(await Receipt.countDocuments({})).toBe(2);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('ignores an event with no orderId in metadata', async () => {
    await paidOrder();
    stripeWebhookEvent({
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_hook', amount: 40_000, metadata: {} } },
    });

    await request(app)
      .post('/api/stripe/webhook')
      .set('stripe-signature', 'sig_test')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'))
      .expect(200);

    expect(await Receipt.countDocuments({})).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
