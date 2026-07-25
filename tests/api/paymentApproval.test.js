import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../app.js';
import WorkHoursOrder from '../../models/WorkHoursOrder.js';
import Receipt        from '../../models/Receipt.js';
import Counter        from '../../models/Counter.js';
import Message        from '../../models/Message.js';
import { stripeMock } from '../mocks/stripe.js';
import { sendMail }   from '../setup.js';
import {
  createContractor, createTradePro, createSite,
  createPendingPaymentMessage, createDepositMessage,
  asContractor,
} from '../helpers/factories.js';

const url = (id) => `/api/contractor/payment-approvals/${id}`;

// 8h × $50 × 1 worker = $400; 10% platform fee ⇒ $40 fee, $360 payout.
const ORDER_SUM = 400;
const FEE       = 40;
const PAYOUT    = 360;

let contractor, trade, site;

async function setupScenario({ tradeOverrides = {}, withDeposit = true } = {}) {
  contractor = await createContractor({ companyName: 'Acme Builders' });
  trade      = await createTradePro({ fullName: 'Pat Tradesman', hourlyRate: 50, ...tradeOverrides });
  site       = await createSite(contractor, { name: 'Downtown Tower' });

  if (withDeposit) {
    await createDepositMessage({ contractor, tradePro: trade, site, minDeposit: 10_000 });
  }
  return createPendingPaymentMessage({ contractor, tradePro: trade, site, actualHours: 8, workersNo: 1 });
}

describe('PATCH /api/contractor/payment-approvals/:orderId', () => {
  describe('validation and authorization', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await request(app).patch(url('64b7f0000000000000000000')).send({ status: 'approved' });
      expect(res.status).toBe(401);
    });

    it('rejects a status other than approved/rejected', async () => {
      const pending = await setupScenario();
      const res = await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'maybe' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/approved.*rejected/i);
    });

    it('404s on a pending request belonging to another contractor', async () => {
      const pending = await setupScenario();
      const intruder = await createContractor();

      const res = await request(app).patch(url(pending._id)).set(asContractor(intruder)).send({ status: 'approved' });

      expect(res.status).toBe(404);
      // The approval must not have happened for anyone.
      expect(await WorkHoursOrder.countDocuments()).toBe(0);
      expect(await Message.findById(pending._id)).not.toBeNull();
    });
  });

  describe('when the payout settles', () => {
    let pending;
    beforeEach(async () => { pending = await setupScenario(); });

    it('captures the deposit and transfers the payout net of the platform fee', async () => {
      const res = await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'approved' });

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
      // Nothing went wrong downstream, so no warnings key at all.
      expect(res.body.warnings).toBeUndefined();

      expect(stripeMock.paymentIntents.capture).toHaveBeenCalledOnce();
      expect(stripeMock.transfers.create).toHaveBeenCalledOnce();
      expect(stripeMock.transfers.create).toHaveBeenCalledWith(expect.objectContaining({
        amount:             PAYOUT * 100,
        currency:           'usd',
        destination:        'acct_ready',
        source_transaction: 'ch_test_deposit',
      }));
    });

    it('records the order as paid with the fee split and no block reason', async () => {
      await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'approved' });

      const order = await WorkHoursOrder.findOne({ trade_id: trade._id }).lean();
      expect(order).toMatchObject({
        status:              'approved',
        paymentStatus:       'paid',
        order_sum:           ORDER_SUM,
        fee_sum:             FEE,
        payment_sum:         PAYOUT,
        payoutBlockedCode:   null,
        payoutBlockedReason: null,
      });
      expect(order.stripeTransferId).toBe(`tr_test_${PAYOUT * 100}`);
      expect(order.receiptSent).toBe(true);
    });

    it('issues exactly one numbered receipt per party', async () => {
      await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'approved' });

      const receipts = await Receipt.find().sort({ receipt_type: 1 }).lean();
      expect(receipts).toHaveLength(2);

      const [contractorReceipt, tradeReceipt] = receipts;
      expect(contractorReceipt).toMatchObject({
        receipt_type: 'contractor', receipt_number: 'C000001',
        order_sum: ORDER_SUM, fee_sum: FEE, payment_sum: PAYOUT, paymentStatus: 'paid',
      });
      expect(tradeReceipt).toMatchObject({ receipt_type: 'trade', receipt_number: 'T000001' });
      // Denormalized snapshots must survive later edits to the source documents.
      expect(contractorReceipt.trade_name).toBe('Pat Tradesman');
      expect(contractorReceipt.site_name).toBe('Downtown Tower');
    });

    it('emails a receipt with a PDF attachment to both parties', async () => {
      await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'approved' });

      expect(sendMail).toHaveBeenCalledTimes(2);
      const recipients = sendMail.mock.calls.map(([arg]) => arg.to);
      expect(recipients).toEqual(expect.arrayContaining([contractor.email, trade.email]));

      for (const [arg] of sendMail.mock.calls) {
        expect(arg.attachments).toHaveLength(1);
        expect(arg.attachments[0].filename).toMatch(/^TradeLink-Receipt-[CT]\d{6}\.pdf$/);
      }
    });

    it('consumes the pending message so the same work cannot be approved twice', async () => {
      await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'approved' });
      expect(await Message.findById(pending._id)).toBeNull();

      const second = await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'approved' });
      expect(second.status).toBe(404);
      expect(await WorkHoursOrder.countDocuments()).toBe(1);
      expect(await Receipt.countDocuments()).toBe(2);
    });
  });

  describe('when the payout is blocked', () => {
    let pending;
    beforeEach(async () => {
      // No connected account at all — verifyPayoutReady short-circuits to no_account.
      pending = await setupScenario({ tradeOverrides: { stripeAccountId: null, stripeOnboarded: false } });
    });

    it('still approves the work, but never attempts a transfer', async () => {
      const res = await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'approved' });

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
      expect(stripeMock.transfers.create).not.toHaveBeenCalled();

      const order = await WorkHoursOrder.findOne({ trade_id: trade._id }).lean();
      expect(order.status).toBe('approved');
      expect(order.order_sum).toBe(ORDER_SUM);
    });

    it('marks the order failed and records why, so the trade pro can be told', async () => {
      await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'approved' });

      const order = await WorkHoursOrder.findOne({ trade_id: trade._id }).lean();
      expect(order).toMatchObject({
        paymentStatus:     'failed',
        payoutBlockedCode: 'no_account',
        // The amount is still owed and must be visible, not left blank.
        payment_sum:       PAYOUT,
        fee_sum:           FEE,
      });
      expect(order.stripeTransferId).toBeNull();
      expect(order.payoutBlockedReason).toMatch(/bank details/i);
    });

    it('issues no receipt and burns no receipt number', async () => {
      // A receipt is proof money moved. Allocating one here would consume a
      // sequential number on a non-payment and duplicate it once the payout clears.
      await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'approved' });

      expect(await Receipt.countDocuments()).toBe(0);
      expect(await Counter.countDocuments()).toBe(0);
    });

    it('sends a plain notice — with no PDF — to both parties', async () => {
      await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'approved' });

      expect(sendMail).toHaveBeenCalledTimes(2);
      for (const [arg] of sendMail.mock.calls) {
        expect(arg.attachments).toBeUndefined();
      }
      const recipients = sendMail.mock.calls.map(([arg]) => arg.to);
      expect(recipients).toEqual(expect.arrayContaining([contractor.email, trade.email]));
    });

    it('returns a warning naming the trade pro and the reason', async () => {
      const res = await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'approved' });

      const blocked = res.body.warnings.find(w => w.stage === 'payout_blocked');
      expect(blocked).toBeDefined();
      expect(blocked.code).toBe('no_account');
      expect(blocked.message).toContain('Pat Tradesman');
      expect(blocked.message).toMatch(/still owed/i);
    });

    it('surfaces the order through GET /api/trade/payout-blocked', async () => {
      // End-to-end: the block written at approval time is what the trade pro's
      // dashboard reads back.
      await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'approved' });

      const { asTrade } = await import('../helpers/factories.js');
      const res = await request(app).get('/api/trade/payout-blocked').set(asTrade(trade));

      expect(res.body).toMatchObject({ blocked: true, count: 1, totalOwed: PAYOUT, code: 'no_account' });
    });
  });

  describe('when Stripe rejects the transfer itself', () => {
    it('records transfer_failed and warns, rather than reporting success', async () => {
      const pending = await setupScenario();
      stripeMock.transfers.create.mockRejectedValueOnce(new Error('Insufficient funds in your Stripe balance'));

      const res = await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'approved' });

      expect(res.status).toBe(200);
      const order = await WorkHoursOrder.findOne({ trade_id: trade._id }).lean();
      expect(order).toMatchObject({ paymentStatus: 'failed', payoutBlockedCode: 'transfer_failed' });
      expect(order.payoutBlockedReason).toContain('Insufficient funds');

      expect(res.body.warnings.some(w => w.stage === 'deposit_transfer')).toBe(true);
      // No money moved ⇒ no receipt.
      expect(await Receipt.countDocuments()).toBe(0);
    });
  });

  describe('rejection', () => {
    it('creates no order and leaves a rejected snapshot behind', async () => {
      const pending = await setupScenario();

      const res = await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'rejected' });

      expect(res.status).toBe(200);
      expect(await WorkHoursOrder.countDocuments()).toBe(0);
      expect(await Receipt.countDocuments()).toBe(0);
      expect(stripeMock.transfers.create).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();

      const snapshot = await Message.findOne({ type: 'payment', status: 'rejected' }).lean();
      expect(JSON.parse(snapshot.text)).toMatchObject({ actual_hours: 8, hourly_rate: 50, order_sum: ORDER_SUM });
      expect(await Message.findById(pending._id)).toBeNull();
    });
  });

  describe('minimum billable hours from the site budget', () => {
    it('bills the site minimum when fewer hours were actually worked', async () => {
      contractor = await createContractor();
      trade      = await createTradePro({ professionality: 'Painter', hourlyRate: 50 });
      site       = await createSite(contractor, {
        tradesNeeded: [{ name: 'Painter', budgetType: 'hours', totalHours: 10 }],
      });
      await createDepositMessage({ contractor, tradePro: trade, site, minDeposit: 10_000 });
      const pending = await createPendingPaymentMessage({ contractor, tradePro: trade, site, actualHours: 6, workersNo: 1 });

      await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'approved' });

      const order = await WorkHoursOrder.findOne().lean();
      expect(order.actual_hours).toBe(10);   // 6 worked, 10 minimum
      expect(order.order_sum).toBe(500);
    });

    it('bills the actual hours when they exceed the minimum', async () => {
      contractor = await createContractor();
      trade      = await createTradePro({ professionality: 'Painter', hourlyRate: 50 });
      site       = await createSite(contractor, {
        tradesNeeded: [{ name: 'Painter', budgetType: 'hours', totalHours: 4 }],
      });
      await createDepositMessage({ contractor, tradePro: trade, site, minDeposit: 10_000 });
      const pending = await createPendingPaymentMessage({ contractor, tradePro: trade, site, actualHours: 9, workersNo: 2 });

      await request(app).patch(url(pending._id)).set(asContractor(contractor)).send({ status: 'approved' });

      const order = await WorkHoursOrder.findOne().lean();
      expect(order.actual_hours).toBe(9);
      expect(order.workers_no).toBe(2);
      expect(order.order_sum).toBe(900);   // 9 × 50 × 2
    });
  });
});
