import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../app.js';
import { sendMail } from '../setup.js';
import { stripeMock } from '../mocks/stripe.js';
import Contractor from '../../models/Contractor.js';
import Message from '../../models/Message.js';
import Receipt from '../../models/Receipt.js';
import WorkHoursOrder from '../../models/WorkHoursOrder.js';
import {
  createContractor, createTradePro, createSite,
  createPendingPaymentMessage, createDepositMessage,
  asContractor,
} from '../helpers/factories.js';

const recipients = () => sendMail.mock.calls.map(([a]) => a.to);
const mailTo = (addr) => sendMail.mock.calls.map(([a]) => a).filter(a => a.to === addr);

/** Makes only the send to `addr` fail; everything else goes through. */
const failMailTo = (addr) => sendMail.mockImplementation(async ({ to }) => {
  if (to === addr) throw new Error('Resend error: mailbox unavailable');
  return { id: 'ok' };
});

const BLOCKED_ACCOUNT = { id: 'acct_x', payouts_enabled: false, external_accounts: { data: [] } };

async function approvalScenario() {
  const contractor = await createContractor();
  const tradePro   = await createTradePro();
  const site       = await createSite(contractor);
  await createDepositMessage({ contractor, tradePro, site, minDeposit: 10_000 });
  const pending = await createPendingPaymentMessage({ contractor, tradePro, site });
  return { contractor, tradePro, site, pending };
}

const approve = (contractor, pending) =>
  request(app)
    .patch(`/api/contractor/payment-approvals/${pending._id}`)
    .set(asContractor(contractor))
    .send({ status: 'approved' });

describe('receipt emails are delivered independently', () => {
  it('sends the trade pro their receipt when the contractor has no address', async () => {
    const { contractor, tradePro, pending } = await approvalScenario();
    await Contractor.findByIdAndUpdate(contractor._id, { $unset: { email: 1 } });

    await approve(contractor, pending).expect(200);

    expect(recipients()).toEqual([tradePro.email]);
    expect(mailTo(tradePro.email)[0].attachments[0].filename).toBe('TradeLink-Receipt-T000001.pdf');
  });

  it("sends the trade pro their receipt when the contractor's send fails", async () => {
    const { contractor, tradePro, pending } = await approvalScenario();
    failMailTo(contractor.email);

    const res = await approve(contractor, pending).expect(200);

    expect(recipients()).toContain(tradePro.email);
    expect(res.body.warnings.map(w => w.stage)).toContain('contractor_receipt_email');
    // The contractor's receipt did not go out, so the flag must stay false.
    expect((await WorkHoursOrder.findOne({}).lean()).receiptSent).toBe(false);
  });

  it("still sends the contractor's receipt when the trade pro's fails", async () => {
    const { contractor, tradePro, pending } = await approvalScenario();
    failMailTo(tradePro.email);

    const res = await approve(contractor, pending).expect(200);

    expect(recipients()).toContain(contractor.email);
    expect(res.body.warnings.map(w => w.stage)).toContain('trade_receipt_email');
    expect((await WorkHoursOrder.findOne({}).lean()).receiptSent).toBe(true);
  });

  it('reports both failures separately when neither can be delivered', async () => {
    const { contractor, pending } = await approvalScenario();
    sendMail.mockRejectedValue(new Error('Resend down'));

    const res = await approve(contractor, pending).expect(200);

    expect(res.body.warnings.map(w => w.stage).sort())
      .toEqual(['contractor_receipt_email', 'trade_receipt_email']);
    expect((await WorkHoursOrder.findOne({}).lean()).receiptSent).toBe(false);
  });

  it('happy path still sends both, in order, with numbered attachments', async () => {
    const { contractor, tradePro, pending } = await approvalScenario();

    const res = await approve(contractor, pending).expect(200);

    expect(recipients()).toEqual([contractor.email, tradePro.email]);
    expect(mailTo(contractor.email)[0].attachments[0].filename).toBe('TradeLink-Receipt-C000001.pdf');
    expect(mailTo(tradePro.email)[0].attachments[0].filename).toBe('TradeLink-Receipt-T000001.pdf');
    expect(res.body.warnings).toBeUndefined();
    expect(await Receipt.countDocuments({})).toBe(2);
  });
});

describe('blocked-payout notices are delivered independently', () => {
  it('reaches the trade pro even when the contractor notice fails', async () => {
    // This notice is the only thing telling the trade pro their money is stuck.
    stripeMock.accounts.retrieve.mockResolvedValue(BLOCKED_ACCOUNT);
    const { contractor, tradePro, pending } = await approvalScenario();
    failMailTo(contractor.email);

    const res = await approve(contractor, pending).expect(200);

    expect(recipients()).toContain(tradePro.email);
    expect(mailTo(tradePro.email)[0].html).toMatch(/bank/i);
    expect(res.body.warnings.map(w => w.stage)).toContain('contractor_notice_email');
  });

  it('reaches the trade pro when the contractor has no address', async () => {
    stripeMock.accounts.retrieve.mockResolvedValue(BLOCKED_ACCOUNT);
    const { contractor, tradePro, pending } = await approvalScenario();
    await Contractor.findByIdAndUpdate(contractor._id, { $unset: { email: 1 } });

    await approve(contractor, pending).expect(200);

    expect(recipients()).toEqual([tradePro.email]);
  });

  it('still issues no receipt numbers on a blocked payout', async () => {
    stripeMock.accounts.retrieve.mockResolvedValue(BLOCKED_ACCOUNT);
    const { contractor, tradePro, pending } = await approvalScenario();

    await approve(contractor, pending).expect(200);

    expect(recipients()).toEqual([contractor.email, tradePro.email]);
    expect(await Receipt.countDocuments({})).toBe(0);
    expect(mailTo(contractor.email)[0].attachments).toBeUndefined();
  });
});

describe('deposit-held emails are delivered independently', () => {
  async function depositScenario() {
    const contractor = await createContractor();
    const tradePro   = await createTradePro();
    const site       = await createSite(contractor);
    await Message.create({
      tradePro: tradePro._id, site: site._id, contractor: contractor._id,
      requestedDate: '2026-03-02', tradeName: 'Painter', workersOffered: 2,
      type: 'worker_offer', status: 'approved', senderType: 'trade',
      stripeDepositIntentId: 'pi_dep_1', depositStatus: 'pending',
    });
    stripeMock.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_dep_1', status: 'requires_capture', amount: 250_000, payment_method: 'pm_1',
    });
    return { contractor, tradePro, site };
  }

  const confirm = (contractor, site) =>
    request(app).post('/api/contractor/deposit-confirmed').set(asContractor(contractor))
      .send({ siteId: String(site._id), paymentIntentId: 'pi_dep_1' });

  it("tells the trade pro the job is funded even when the contractor's mail fails", async () => {
    const { contractor, tradePro, site } = await depositScenario();
    failMailTo(contractor.email);

    await confirm(contractor, site).expect(200);

    expect(recipients()).toContain(tradePro.email);
    expect(mailTo(tradePro.email)[0].html).toContain('$2500.00');
  });

  it('still notifies the contractor when the trade pro has no address', async () => {
    const { contractor, tradePro, site } = await depositScenario();
    const TradePro = (await import('../../models/TradePro.js')).default;
    await TradePro.findByIdAndUpdate(tradePro._id, { $unset: { email: 1 } });

    await confirm(contractor, site).expect(200);

    expect(recipients()).toEqual([contractor.email]);
  });

  it('a mail failure never fails the deposit itself', async () => {
    const { contractor, site } = await depositScenario();
    sendMail.mockRejectedValue(new Error('Resend down'));

    const res = await confirm(contractor, site).expect(200);

    expect(res.body.ok).toBe(true);
    expect(await Message.countDocuments({ status: 'deposited' })).toBe(1);
  });

  it('happy path notifies both parties', async () => {
    const { contractor, tradePro, site } = await depositScenario();

    await confirm(contractor, site).expect(200);

    expect(recipients()).toEqual([contractor.email, tradePro.email]);
  });
});
