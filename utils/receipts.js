import Counter from '../models/Counter.js';
import Receipt from '../models/Receipt.js';
import { deliverMailWarning } from './safeMail.js';
import { contractorReceiptEmail, tradeReceiptEmail } from '../email_templates/paymentReceipt.js';
import { contractorReceiptPdf, tradeReceiptPdf } from '../email_templates/receiptPdf.js';

const PLATFORM_FEE_PERCENT = parseFloat(process.env.STRIPE_PLATFORM_FEE_PERCENT ?? '0');

/** Next number in the per-type sequence, e.g. C000007 / T000007. */
export async function nextReceiptNumber(type) {
  const prefix    = type === 'contractor' ? 'C' : 'T';
  const counterId = `${type}_receipt`;
  const counter   = await Counter.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return prefix + String(counter.seq).padStart(6, '0');
}

/** "Monday, March 2, 2026" from a YYYY-MM-DD string. */
export function formatReceiptDate(date) {
  if (!date) return '—';
  return new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

/**
 * Issues one receipt end to end: writes the ledger row, renders the PDF, emails
 * it, then records on the row what actually happened.
 *
 * The number is allocated because the payout settled, so the document is owed
 * whether or not it reaches anyone — but the row must not silently imply it was
 * delivered. `emailedAt` stays null and `deliveryError` carries the reason, so a
 * resend pass has something to select on.
 *
 * A PDF failure downgrades to an email without the attachment rather than
 * costing the recipient their notice entirely; the body says so and quotes the
 * receipt number.
 *
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string }>}
 */
export async function issueReceipt({ receiptDoc, to, stage, filename, buildPdf, buildEmail, warnings }) {
  const receipt = await Receipt.create(receiptDoc);

  let pdf = null;
  try {
    pdf = await buildPdf();
  } catch (pdfErr) {
    console.error(`[receipt ${receipt.receipt_number}] PDF generation failed: ${pdfErr.message}`);
    warnings?.push({ stage: `${stage}_pdf`, message: pdfErr.message });
  }

  const result = await deliverMailWarning({
    to,
    stage,
    build: () => ({
      ...buildEmail({ pdfAttached: !!pdf, receiptNumber: receipt.receipt_number }),
      ...(pdf ? { attachments: [{ filename, content: pdf }] } : {}),
    }),
  }, warnings);

  await Receipt.findByIdAndUpdate(receipt._id, {
    emailedAt:     result.ok ? new Date() : null,
    deliveryError: result.error ?? (result.skipped ? 'no recipient address' : null),
    pdfAttached:   result.ok && !!pdf,
  });

  return result;
}

/**
 * Issues BOTH receipts for a settled order — the contractor's and the trade
 * pro's — and emails them.
 *
 * This is the single entry point for receipt issuance. There used to be two
 * implementations: the approval flow produced numbered receipts backed by ledger
 * rows, while the Stripe webhook sent a numberless PDF and wrote nothing to the
 * ledger at all, so the record a contractor ended up with depended on which
 * payment route they happened to take. Both callers now come through here.
 *
 * Idempotent per order: a receipt number is a permanent accounting artefact, so
 * an order that already has receipts is never given a second set — whichever
 * flow gets there first wins and the other becomes a no-op.
 *
 * @returns {Promise<{ skipped: boolean, contractor?: object, trade?: object }>}
 */
export async function issueOrderReceipts({
  order,
  contractor,
  tradePro,
  site,
  siteId,
  orderSum,
  feeDollars,
  payoutAmount,
  feePercent = PLATFORM_FEE_PERCENT,
  warnings,
}) {
  const alreadyIssued = await Receipt.countDocuments({ order_id: order._id });
  if (alreadyIssued > 0) {
    console.log(`[receipts] order ${order._id} already has ${alreadyIssued} receipt(s) — not issuing again`);
    return { skipped: true };
  }

  const tradeName       = tradePro?.fullName        ?? 'Trade Pro';
  const tradeProfession = tradePro?.professionality ?? '—';
  const siteName        = site?.name    ?? '—';
  const siteAddress     = site?.address ?? '—';
  const displayDate     = formatReceiptDate(order.date);

  // Shared by the email bodies and the PDFs.
  const receiptFields = {
    contractorName: contractor?.companyName ?? '—',
    tradeName,
    siteName,
    displayDate,
    actualHours: order.actual_hours,
    workersNo:   order.workers_no,
    hourlyRate:  order.hourly_rate,
    orderSum,
    feePercent,
    feeDollars,
  };

  // Shared by both ledger rows — they describe the same job.
  const receiptBase = {
    order_id:              order._id,
    contractor_id:         contractor?._id ?? null,
    trade_id:              tradePro?._id   ?? null,
    site_id:               siteId ?? site?._id ?? null,
    contractor_name:       contractor?.companyName ?? '—',
    trade_name:            tradeName,
    trade_professionality: tradeProfession,
    site_name:             siteName,
    site_address:          siteAddress,
    date:                  order.date,
    actual_hours:          order.actual_hours,
    workers_no:            order.workers_no,
    hourly_rate:           order.hourly_rate,
    order_sum:             orderSum,
    fee_sum:               feeDollars,
    payment_sum:           payoutAmount,
    paymentStatus:         'paid',
  };

  // Delivered independently — neither party's receipt may depend on the other's
  // address existing or their send succeeding.
  const contractorReceiptNo = await nextReceiptNumber('contractor');
  const contractorResult = await issueReceipt({
    receiptDoc: { ...receiptBase, receipt_number: contractorReceiptNo, receipt_type: 'contractor' },
    to:         contractor?.email,
    stage:      'contractor_receipt_email',
    filename:   `TradeLink-Receipt-${contractorReceiptNo}.pdf`,
    buildPdf:   () => contractorReceiptPdf({ ...receiptFields, receiptNumber: contractorReceiptNo }),
    buildEmail: (flags) => contractorReceiptEmail({ ...receiptFields, ...flags }),
    warnings,
  });

  // Same format, but shows their payout rather than the full order sum.
  const tradeReceiptNo = await nextReceiptNumber('trade');
  const tradeResult = await issueReceipt({
    receiptDoc: { ...receiptBase, receipt_number: tradeReceiptNo, receipt_type: 'trade' },
    to:         tradePro?.email,
    stage:      'trade_receipt_email',
    filename:   `TradeLink-Receipt-${tradeReceiptNo}.pdf`,
    buildPdf:   () => tradeReceiptPdf({ ...receiptFields, payoutAmount, receiptNumber: tradeReceiptNo }),
    buildEmail: (flags) => tradeReceiptEmail({ ...receiptFields, payoutAmount, ...flags }),
    warnings,
  });

  return { skipped: false, contractor: contractorResult, trade: tradeResult };
}
