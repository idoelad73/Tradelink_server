/**
 * One-time repair script.
 * Finds all tradehours_orders where paymentStatus === 'paid' and receiptSent !== true,
 * recalculates fee_sum / payment_sum from STRIPE_PLATFORM_FEE_PERCENT,
 * sends the receipt email to the contractor, then marks receiptSent: true.
 *
 * Run from the server/ directory:
 *   node --env-file=.env scripts/repairPaidOrders.js
 */

import mongoose from 'mongoose';
import nodemailer from 'nodemailer';
import '../models/Contractor.js';
import '../models/TradePro.js';
import '../models/Site.js';
import WorkHoursOrder from '../models/WorkHoursOrder.js';

// ── Config ────────────────────────────────────────────────────────────────────
const MONGO_URI           = process.env.MONGO_URI;
const PLATFORM_FEE_PERCENT = parseFloat(process.env.STRIPE_PLATFORM_FEE_PERCENT ?? '0');
const GMAIL_USER          = process.env.GMAIL_USER;
const GMAIL_PASS          = process.env.GMAIL_APP_PASSWORD;

if (!MONGO_URI) { console.error('MONGO_URI not set'); process.exit(1); }

// ── Mailer ─────────────────────────────────────────────────────────────────────
function sendMail({ to, subject, html }) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
  return transporter.sendMail({ from: `"TradeLink" <${GMAIL_USER}>`, to, subject, html });
}

// ── Receipt HTML ───────────────────────────────────────────────────────────────
function buildReceiptHtml({ companyName, tradeName, siteName, displayDate, order, feeDollars, payoutDollars }) {
  const subject = `🧾 Payment Receipt — ${tradeName} · ${siteName} — TradeLink`;
  const totalCharged = order.order_sum;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#f8fafc;padding:24px}</style>
</head><body>
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.08)">
  <div style="background:linear-gradient(135deg,#22c55e,#0ea5e9);padding:28px;text-align:center">
    <h1 style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-.5px">TradeLink</h1>
    <p style="color:rgba(255,255,255,.85);font-size:13px;margin-top:4px">Payment Receipt</p>
  </div>
  <div style="padding:32px">
    <p style="color:#0f172a;font-size:15px;margin-bottom:6px">Hi <strong>${companyName}</strong>,</p>
    <p style="color:#475569;font-size:14px;line-height:1.6;margin-bottom:28px">
      Your payment has been processed successfully. Here is your receipt.
    </p>
    <div style="background:#f0fdf4;border:2px solid #86efac;border-radius:14px;padding:20px;margin-bottom:24px">
      <p style="color:#166534;font-size:13px;font-weight:700;margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em">Order Summary</p>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="color:#475569;font-size:13px;padding:4px 0">🏗️ Trade Pro</td><td style="color:#0f172a;font-size:13px;font-weight:700;text-align:right">${tradeName}</td></tr>
        <tr><td style="color:#475569;font-size:13px;padding:4px 0">📍 Site</td><td style="color:#0f172a;font-size:13px;font-weight:700;text-align:right">${siteName}</td></tr>
        <tr><td style="color:#475569;font-size:13px;padding:4px 0">📅 Date</td><td style="color:#0f172a;font-size:13px;font-weight:700;text-align:right">${displayDate}</td></tr>
        <tr><td style="color:#475569;font-size:13px;padding:4px 0">⏱️ Hours</td><td style="color:#0f172a;font-size:13px;font-weight:700;text-align:right">${order.actual_hours}h</td></tr>
        <tr><td style="color:#475569;font-size:13px;padding:4px 0">👷 Workers</td><td style="color:#0f172a;font-size:13px;font-weight:700;text-align:right">${order.workers_no}</td></tr>
        <tr><td style="color:#475569;font-size:13px;padding:4px 0">💵 Rate</td><td style="color:#0f172a;font-size:13px;font-weight:700;text-align:right">$${order.hourly_rate}/hr</td></tr>
        <tr style="border-top:1.5px solid #86efac">
          <td style="color:#475569;font-size:13px;padding:8px 0 4px">Order Total</td>
          <td style="color:#0f172a;font-size:13px;font-weight:700;text-align:right;padding:8px 0 4px">$${totalCharged}</td>
        </tr>
        <tr><td style="color:#475569;font-size:13px;padding:4px 0">Platform Fee (${PLATFORM_FEE_PERCENT}%)</td><td style="color:#64748b;font-size:13px;text-align:right">$${feeDollars}</td></tr>
      </table>
    </div>
    <div style="background:#ecfdf5;border:2px solid #34d399;border-radius:12px;padding:16px;text-align:center;margin-bottom:28px">
      <p style="color:#065f46;font-size:13px;font-weight:600;margin-bottom:4px">Total Charged</p>
      <p style="color:#065f46;font-size:28px;font-weight:800">$${totalCharged}</p>
    </div>
    <p style="color:#94a3b8;font-size:12px;text-align:center;line-height:1.6">
      Thank you for using TradeLink. Please keep this email as your payment record.
    </p>
  </div>
  <div style="background:#f8fafc;padding:16px;text-align:center;border-top:1px solid #e2e8f0">
    <p style="color:#94a3b8;font-size:11px">TradeLink · Connecting trade professionals with projects</p>
  </div>
</div>
</body></html>`;
  return { subject, html };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB\n');

  const orders = await WorkHoursOrder.find({
    paymentStatus: 'paid',
    receiptSent:   { $ne: true },
  })
    .populate('contractor_id', 'companyName email')
    .populate('trade_id',      'fullName')
    .populate('site_id',       'name');

  if (orders.length === 0) {
    console.log('Nothing to repair — all paid orders already have receipts.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${orders.length} order(s) to repair:\n`);

  for (const order of orders) {
    const orderId   = order._id;
    const orderSum  = order.order_sum ?? 0;
    const feeDollars    = parseFloat((orderSum * PLATFORM_FEE_PERCENT / 100).toFixed(2));
    const payoutDollars = parseFloat((orderSum - feeDollars).toFixed(2));

    const contractorEmail = order.contractor_id?.email;
    const companyName     = order.contractor_id?.companyName ?? 'Contractor';
    const tradeName       = order.trade_id?.fullName        ?? 'Trade Pro';
    const siteName        = order.site_id?.name             ?? '—';
    const displayDate     = order.date
      ? new Date(order.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      : '—';

    console.log(`Order ${orderId}`);
    console.log(`  order_sum    : $${orderSum}`);
    console.log(`  fee (${PLATFORM_FEE_PERCENT}%)   : $${feeDollars}`);
    console.log(`  payment_sum  : $${payoutDollars}`);
    console.log(`  contractor   : ${contractorEmail ?? '—'}`);

    // 1. Fix fee_sum and payment_sum
    await WorkHoursOrder.findByIdAndUpdate(orderId, {
      fee_sum:     feeDollars,
      payment_sum: payoutDollars,
      receiptSent: false,
    });
    console.log(`  DB updated   ✅`);

    // 2. Send receipt email
    if (contractorEmail) {
      const { subject, html } = buildReceiptHtml({ companyName, tradeName, siteName, displayDate, order, feeDollars, payoutDollars });
      try {
        await sendMail({ to: contractorEmail, subject, html });
        await WorkHoursOrder.findByIdAndUpdate(orderId, { receiptSent: true });
        console.log(`  Email sent   ✅  → ${contractorEmail}`);
      } catch (err) {
        console.error(`  Email FAILED ❌  ${err.message}`);
      }
    } else {
      console.warn(`  No email on contractor — skipping receipt`);
    }
    console.log('');
  }

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => { console.error(err); process.exit(1); });
