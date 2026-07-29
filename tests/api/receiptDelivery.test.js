import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import app from '../../app.js';
import { sendMail } from '../setup.js';
import { stripeMock } from '../mocks/stripe.js';
import * as receiptPdf from '../../email_templates/receiptPdf.js';
import Contractor from '../../models/Contractor.js';
import Message from '../../models/Message.js';
import Receipt from '../../models/Receipt.js';
import Counter from '../../models/Counter.js';
import {
  createContractor, createTradePro, createSite,
  createPendingPaymentMessage, createDepositMessage,
  asContractor,
} from '../helpers/factories.js';

const recipients = () => sendMail.mock.calls.map(([a]) => a.to);
const mailTo = (addr) => sendMail.mock.calls.map(([a]) => a).filter(a => a.to === addr);

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

describe('R3 — the ledger records whether a receipt was actually delivered', () => {
  it('marks both receipts delivered on the happy path', async () => {
    const { contractor, pending } = await approvalScenario();
    await approve(contractor, pending).expect(200);

    const receipts = await Receipt.find({}).sort({ receipt_type: 1 }).lean();
    expect(receipts).toHaveLength(2);
    for (const r of receipts) {
      expect(r.emailedAt).toBeInstanceOf(Date);
      expect(r.deliveryError).toBeNull();
      expect(r.pdfAttached).toBe(true);
    }
  });

  it('leaves emailedAt null and records the reason when delivery fails', async () => {
    const { contractor, pending } = await approvalScenario();
    sendMail.mockRejectedValue(new Error('Resend error: mailbox unavailable'));

    await approve(contractor, pending).expect(200);

    const receipts = await Receipt.find({}).lean();
    expect(receipts).toHaveLength(2);
    for (const r of receipts) {
      expect(r.emailedAt).toBeNull();
      expect(r.deliveryError).toMatch(/mailbox unavailable/);
      expect(r.pdfAttached).toBe(false);
    }
  });

  it('records a missing address distinctly from a send failure', async () => {
    const { contractor, tradePro, pending } = await approvalScenario();
    await Contractor.findByIdAndUpdate(contractor._id, { $unset: { email: 1 } });

    await approve(contractor, pending).expect(200);

    const c = await Receipt.findOne({ receipt_type: 'contractor' }).lean();
    const t = await Receipt.findOne({ receipt_type: 'trade' }).lean();

    expect(c.emailedAt).toBeNull();
    expect(c.deliveryError).toBe('no recipient address');
    expect(t.emailedAt).toBeInstanceOf(Date);   // trade pro unaffected
    expect(recipients()).toEqual([tradePro.email]);
  });

  it('undelivered receipts are queryable for a resend pass', async () => {
    const a = await approvalScenario();
    sendMail.mockRejectedValue(new Error('Resend down'));
    await approve(a.contractor, a.pending).expect(200);

    sendMail.mockReset().mockResolvedValue({ id: 'ok' });
    const b = await approvalScenario();
    await approve(b.contractor, b.pending).expect(200);

    const outstanding = await Receipt.find({ emailedAt: null }).lean();
    expect(outstanding).toHaveLength(2);
    expect(outstanding.map(r => r.receipt_number).sort()).toEqual(['C000001', 'T000001']);

    // Numbering stays contiguous — the second approval continued the sequence.
    expect((await Counter.findById('contractor_receipt').lean()).seq).toBe(2);
  });
});

describe('R4 — a PDF failure costs the attachment, not the email', () => {
  it("still emails the contractor when their PDF can't be rendered", async () => {
    const { contractor, pending } = await approvalScenario();
    vi.spyOn(receiptPdf, 'contractorReceiptPdf').mockRejectedValueOnce(new Error('pdfkit exploded'));

    const res = await approve(contractor, pending).expect(200);

    expect(recipients()).toContain(contractor.email);
    const mail = mailTo(contractor.email)[0];
    expect(mail.attachments).toBeUndefined();
    // The body must not claim an attachment that is not there.
    expect(mail.html).not.toContain('attached to this email as a PDF');
    expect(mail.html).toContain('could not attach the PDF');
    expect(mail.html).toContain('C000001');

    expect(res.body.warnings.map(w => w.stage)).toContain('contractor_receipt_email_pdf');
  });

  it('records the downgrade on the ledger row', async () => {
    const { contractor, pending } = await approvalScenario();
    vi.spyOn(receiptPdf, 'contractorReceiptPdf').mockRejectedValueOnce(new Error('pdfkit exploded'));

    await approve(contractor, pending).expect(200);

    const c = await Receipt.findOne({ receipt_type: 'contractor' }).lean();
    expect(c.emailedAt).toBeInstanceOf(Date);   // it WAS delivered
    expect(c.pdfAttached).toBe(false);          // …just without the PDF
    expect(c.deliveryError).toBeNull();
  });

  it("one recipient's PDF failure does not touch the other's", async () => {
    const { contractor, tradePro, pending } = await approvalScenario();
    vi.spyOn(receiptPdf, 'contractorReceiptPdf').mockRejectedValueOnce(new Error('pdfkit exploded'));

    await approve(contractor, pending).expect(200);

    expect(recipients()).toEqual([contractor.email, tradePro.email]);
    expect(mailTo(tradePro.email)[0].attachments[0].filename).toBe('TradeLink-Receipt-T000001.pdf');
    expect((await Receipt.findOne({ receipt_type: 'trade' }).lean()).pdfAttached).toBe(true);
  });

  it('a PDF failure on both sides still delivers both emails', async () => {
    const { contractor, tradePro, pending } = await approvalScenario();
    vi.spyOn(receiptPdf, 'contractorReceiptPdf').mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(receiptPdf, 'tradeReceiptPdf').mockRejectedValueOnce(new Error('boom'));

    const res = await approve(contractor, pending).expect(200);

    expect(recipients()).toEqual([contractor.email, tradePro.email]);
    expect(res.body.warnings.map(w => w.stage).sort())
      .toEqual(['contractor_receipt_email_pdf', 'trade_receipt_email_pdf']);
    expect(await Receipt.countDocuments({ emailedAt: { $ne: null } })).toBe(2);
  });
});

describe('D2 — deposit confirmation is idempotent', () => {
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

  it('records one deposit and emails once, however many times it is called', async () => {
    const { contractor, tradePro, site } = await depositScenario();

    const first  = await confirm(contractor, site).expect(200);
    const second = await confirm(contractor, site).expect(200);
    const third  = await confirm(contractor, site).expect(200);

    expect(await Message.countDocuments({ status: 'deposited' })).toBe(1);
    expect(recipients()).toEqual([contractor.email, tradePro.email]);

    // Every call reports the same deposit, so the client stays consistent.
    expect(second.body.messageId).toBe(first.body.messageId);
    expect(third.body.messageId).toBe(first.body.messageId);
    expect(first.body.alreadyProcessed).toBeUndefined();
    expect(second.body.alreadyProcessed).toBe(true);
  });

  it('holds under concurrent double-submit', async () => {
    const { contractor, site } = await depositScenario();

    await Promise.all([confirm(contractor, site), confirm(contractor, site)]);

    expect(await Message.countDocuments({ status: 'deposited' })).toBe(1);
  });

  it('keeps the deposit amount from the first confirmation', async () => {
    const { contractor, site } = await depositScenario();
    await confirm(contractor, site).expect(200);

    // A later call reporting a different amount must not rewrite the record.
    stripeMock.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_dep_1', status: 'requires_capture', amount: 999_900, payment_method: 'pm_1',
    });
    await confirm(contractor, site).expect(200);

    const deposit = await Message.findOne({ status: 'deposited' }).lean();
    expect(deposit.min_deposit).toBe(2500);
  });

  it('a different PaymentIntent still records its own deposit', async () => {
    const { contractor, site } = await depositScenario();
    await confirm(contractor, site).expect(200);

    await Message.create({
      tradePro: (await createTradePro())._id, site: site._id, contractor: contractor._id,
      requestedDate: '2026-04-02', tradeName: 'Plumber', workersOffered: 1,
      type: 'worker_offer', status: 'approved', senderType: 'trade',
      stripeDepositIntentId: 'pi_dep_2', depositStatus: 'pending',
    });
    stripeMock.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_dep_2', status: 'requires_capture', amount: 100_000, payment_method: 'pm_1',
    });

    await request(app).post('/api/contractor/deposit-confirmed').set(asContractor(contractor))
      .send({ siteId: String(site._id), paymentIntentId: 'pi_dep_2' }).expect(200);

    expect(await Message.countDocuments({ status: 'deposited' })).toBe(2);
  });
});
