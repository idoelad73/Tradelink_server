/**
 * Repair script — run once from server/ directory:
 *   node --env-file=.env scripts/repairPaidOrders.js
 *
 * For every paid order:
 *  1. Recalculates fee_sum / payment_sum from STRIPE_PLATFORM_FEE_PERCENT
 *  2. Creates contractor + trade Receipt documents (skips if already exists)
 *  3. Sends receipt email to contractor if not yet sent
 */

import mongoose from 'mongoose';
import { Resend } from 'resend';
import '../models/Contractor.js';
import '../models/TradePro.js';
import '../models/Site.js';
import WorkHoursOrder from '../models/WorkHoursOrder.js';
import Counter from '../models/Counter.js';
import Receipt from '../models/Receipt.js';

// ── Config ────────────────────────────────────────────────────────────────────
const MONGO_URI            = process.env.MONGO_URI;
const PLATFORM_FEE_PERCENT = parseFloat(process.env.STRIPE_PLATFORM_FEE_PERCENT ?? '0');
const FROM                 = process.env.RESEND_FROM_EMAIL ?? 'TradeLink <noreply@tradelink.com>';
const resend               = new Resend(process.env.RESEND_API_KEY);

if (!MONGO_URI) { console.error('MONGO_URI not set'); process.exit(1); }

// ── Helpers ───────────────────────────────────────────────────────────────────
async function nextReceiptNumber(type) {
  const prefix    = type === 'contractor' ? 'C' : 'T';
  const counterId = `${type}_receipt`;
  const counter   = await Counter.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return prefix + String(counter.seq).padStart(6, '0');
}

async function sendMail({ to, subject, html }) {
  const { error } = await resend.emails.send({ from: FROM, to, subject, html });
  if (error) throw new Error(`Resend error: ${error.message}`);
}

function buildReceiptHtml({ companyName, tradeName, siteName, displayDate, order, receiptNumber }) {
  const subject = `🧾 Receipt ${receiptNumber} — ${tradeName} · ${siteName} — TradeLink`;
  const total   = order.order_sum;
  const html    = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#f8fafc;padding:24px}</style>
</head><body>
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.08)">
  <div style="background:linear-gradient(135deg,#22c55e,#0ea5e9);padding:28px 28px 20px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <h1 style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-.5px">TradeLink</h1>
        <p style="color:rgba(255,255,255,.85);font-size:13px;margin-top:4px">Payment Receipt</p>
      </div>
      <div style="text-align:right">
        <p style="color:rgba(255,255,255,.7);font-size:10px;margin-bottom:2px">Receipt No.</p>
        <p style="color:#fff;font-size:16px;font-weight:800;letter-spacing:.05em">${receiptNumber}</p>
      </div>
    </div>
  </div>
  <div style="padding:32px">
    <p style="color:#0f172a;font-size:15px;margin-bottom:6px">Hi <strong>${companyName}</strong>,</p>
    <p style="color:#475569;font-size:14px;line-height:1.6;margin-bottom:28px">Your payment has been processed successfully.</p>
    <div style="background:#f0fdf4;border:2px solid #86efac;border-radius:14px;padding:20px;margin-bottom:24px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="color:#475569;font-size:13px;padding:4px 0">🏗️ Trade Pro</td><td style="color:#0f172a;font-size:13px;font-weight:700;text-align:right">${tradeName}</td></tr>
        <tr><td style="color:#475569;font-size:13px;padding:4px 0">📍 Site</td><td style="color:#0f172a;font-size:13px;font-weight:700;text-align:right">${siteName}</td></tr>
        <tr><td style="color:#475569;font-size:13px;padding:4px 0">📅 Date</td><td style="color:#0f172a;font-size:13px;font-weight:700;text-align:right">${displayDate}</td></tr>
        <tr><td style="color:#475569;font-size:13px;padding:4px 0">⏱️ Hours</td><td style="color:#0f172a;font-size:13px;font-weight:700;text-align:right">${order.actual_hours}h</td></tr>
        <tr><td style="color:#475569;font-size:13px;padding:4px 0">👷 Workers</td><td style="color:#0f172a;font-size:13px;font-weight:700;text-align:right">${order.workers_no}</td></tr>
        <tr><td style="color:#475569;font-size:13px;padding:4px 0">💵 Rate</td><td style="color:#0f172a;font-size:13px;font-weight:700;text-align:right">$${order.hourly_rate}/hr</td></tr>
      </table>
    </div>
    <div style="background:#ecfdf5;border:2px solid #34d399;border-radius:12px;padding:16px;text-align:center;margin-bottom:28px">
      <p style="color:#065f46;font-size:13px;font-weight:600;margin-bottom:4px">Total Charged</p>
      <p style="color:#065f46;font-size:28px;font-weight:800">$${total}</p>
    </div>
    <p style="color:#94a3b8;font-size:12px;text-align:center">Thank you for using TradeLink.</p>
  </div>
</div>
</body></html>`;
  return { subject, html };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB\n');

  const orders = await WorkHoursOrder.find({ paymentStatus: 'paid' })
    .populate('contractor_id', 'companyName email')
    .populate('trade_id',      'fullName professionality')
    .populate('site_id',       'name address');

  if (orders.length === 0) {
    console.log('No paid orders found.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${orders.length} paid order(s)\n`);

  for (const order of orders) {
    const orderId      = order._id;
    const orderSum     = order.order_sum ?? 0;
    const feeDollars   = order.fee_sum   ?? parseFloat((orderSum * PLATFORM_FEE_PERCENT / 100).toFixed(2));
    const payoutDollars = order.payment_sum ?? parseFloat((orderSum - feeDollars).toFixed(2));

    const contractorEmail  = order.contractor_id?.email;
    const companyName      = order.contractor_id?.companyName    ?? 'Contractor';
    const tradeName        = order.trade_id?.fullName            ?? 'Trade Pro';
    const tradeProfession  = order.trade_id?.professionality     ?? '—';
    const siteName         = order.site_id?.name                 ?? '—';
    const siteAddress      = order.site_id?.address              ?? '—';
    const displayDate      = order.date
      ? new Date(order.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      : '—';

    console.log(`Order ${orderId}  |  $${orderSum}  |  fee $${feeDollars}  |  payout $${payoutDollars}`);

    // 1. Fix fee_sum / payment_sum if missing
    if (!order.fee_sum || !order.payment_sum) {
      await WorkHoursOrder.findByIdAndUpdate(orderId, { fee_sum: feeDollars, payment_sum: payoutDollars });
      console.log(`  fee/payout fixed  ✅`);
    }

    // 2. Create contractor receipt (skip if already exists for this order)
    const existingC = await Receipt.findOne({ order_id: orderId, receipt_type: 'contractor' });
    let contractorReceiptNo;
    if (existingC) {
      contractorReceiptNo = existingC.receipt_number;
      console.log(`  contractor receipt already exists  ${contractorReceiptNo}  ⏭️`);
    } else {
      contractorReceiptNo = await nextReceiptNumber('contractor');
      await Receipt.create({
        receipt_number:        contractorReceiptNo,
        receipt_type:          'contractor',
        order_id:              orderId,
        contractor_id:         order.contractor_id?._id,
        trade_id:              order.trade_id?._id,
        site_id:               order.site_id?._id,
        contractor_name:       companyName,
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
        payment_sum:           payoutDollars,
        paymentStatus:         'paid',
      });
      console.log(`  contractor receipt created  ${contractorReceiptNo}  ✅`);
    }

    // 3. Create trade receipt (skip if already exists for this order)
    const existingT = await Receipt.findOne({ order_id: orderId, receipt_type: 'trade' });
    if (existingT) {
      console.log(`  trade receipt already exists  ${existingT.receipt_number}  ⏭️`);
    } else {
      const tradeReceiptNo = await nextReceiptNumber('trade');
      await Receipt.create({
        receipt_number:        tradeReceiptNo,
        receipt_type:          'trade',
        order_id:              orderId,
        contractor_id:         order.contractor_id?._id,
        trade_id:              order.trade_id?._id,
        site_id:               order.site_id?._id,
        contractor_name:       companyName,
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
        payment_sum:           payoutDollars,
        paymentStatus:         'paid',
      });
      console.log(`  trade receipt created  ${tradeReceiptNo}  ✅`);
    }

    // 4. Send receipt email to contractor if not yet sent
    if (!order.receiptSent) {
      if (contractorEmail) {
        const { subject, html } = buildReceiptHtml({ companyName, tradeName, siteName, displayDate, order: { ...order.toObject(), order_sum: orderSum }, receiptNumber: contractorReceiptNo });
        try {
          await sendMail({ to: contractorEmail, subject, html });
          await WorkHoursOrder.findByIdAndUpdate(orderId, { receiptSent: true });
          console.log(`  email sent  ✅  → ${contractorEmail}`);
        } catch (err) {
          console.error(`  email FAILED ❌  ${err.message}`);
        }
      } else {
        console.warn(`  no contractor email — skipping email`);
      }
    } else {
      console.log(`  email already sent  ⏭️`);
    }

    console.log('');
  }

  // Show final counter state
  const cCount = await Counter.findById('contractor_receipt');
  const tCount = await Counter.findById('trade_receipt');
  console.log(`Counter state: contractor=${cCount?.seq ?? 0}  trade=${tCount?.seq ?? 0}`);
  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
