import stripe       from '../utils/stripe.js';
import WorkHoursOrder from '../models/WorkHoursOrder.js';
import Contractor     from '../models/Contractor.js';
import TradePro       from '../models/TradePro.js';
import Message        from '../models/Message.js';
import { sendMail }  from '../utils/mailer.js';

// Platform fee % read from .env — e.g. STRIPE_PLATFORM_FEE_PERCENT=5  means 5%
const PLATFORM_FEE_PERCENT = parseFloat(process.env.STRIPE_PLATFORM_FEE_PERCENT ?? '0');

// ── POST /api/stripe/create-payment-intent ────────────────────────────────────
// Authenticated contractor only (auth middleware applied in route).
// Verifies the order is approved, gets/creates a Stripe Customer for the
// contractor, then creates a PaymentIntent server-side.
// Returns { clientSecret, amount, tradeName } — clientSecret is consumed by
// the React PaymentElement; it NEVER passes through our DOM.
export async function createPaymentIntent(req, res, next) {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ message: 'orderId is required' });
    }

    // Verify: order must belong to this contractor AND be approved
    const order = await WorkHoursOrder.findOne({
      _id:           orderId,
      contractor_id: req.userId,
      status:        'approved',
    })
      .populate('trade_id', 'fullName professionality stripeAccountId stripeOnboarded')
      .lean();

    if (!order) {
      return res.status(404).json({ message: 'Approved order not found' });
    }

    if (order.paymentStatus === 'paid') {
      return res.status(409).json({ message: 'This order has already been paid' });
    }

    // ── Get or create Stripe Customer for this contractor ────────────────────
    const contractor = await Contractor.findById(req.userId).select('email companyName stripeCustomerId').lean();

    let customerId = contractor.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: contractor.email,
        name:  contractor.companyName,
        metadata: { contractorId: String(contractor._id) },
      });
      customerId = customer.id;
      // Persist: only the Stripe ID — no card data ever stored
      await Contractor.findByIdAndUpdate(req.userId, { stripeCustomerId: customerId });
    }

    const amountCents = Math.round(order.order_sum * 100); // Stripe works in cents

    // ── Platform fee calculation ─────────────────────────────────────────────
    const tradePro     = order.trade_id;
    const feePercent   = PLATFORM_FEE_PERCENT;                                      // e.g. 5
    const feeCents     = feePercent > 0 ? Math.round(amountCents * feePercent / 100) : 0;
    const payoutCents  = amountCents - feeCents;                                     // TradePro's share
    const feeDollars   = parseFloat((feeCents   / 100).toFixed(2));
    const payoutDollars= parseFloat((payoutCents / 100).toFixed(2));

    console.log(`[Stripe] Order $${order.order_sum} | Fee ${feePercent}% = $${feeDollars} | TradePro payout = $${payoutDollars}`);

    // ── Create PaymentIntent server-side (rule #7) ───────────────────────────
    // application_fee_amount → automatically sent to TradeLink's Stripe platform account
    // transfer_data.destination → sends the remainder to TradePro's connected account
    const hasConnectAcct = tradePro?.stripeOnboarded && tradePro?.stripeAccountId;

    const piParams = {
      amount:   amountCents,
      currency: 'usd',
      customer: customerId,
      automatic_payment_methods: { enabled: true },
      metadata: {
        orderId:       String(order._id),
        contractorId:  String(order.contractor_id),
        tradeId:       String(tradePro._id),
        date:          order.date,
        feePercent:    String(feePercent),
        feeCents:      String(feeCents),
        payoutCents:   String(payoutCents),
      },
      description: `TradeLink — ${tradePro.fullName} (${tradePro.professionality}) ${order.date}`,
    };

    // Only split to TradePro's Stripe account if they have completed Connect onboarding
    if (hasConnectAcct && feeCents > 0) {
      piParams.application_fee_amount = feeCents;
      piParams.transfer_data          = { destination: tradePro.stripeAccountId };
    } else if (!hasConnectAcct) {
      console.warn(`[Stripe] TradePro ${tradePro?._id} not connected — full $${order.order_sum} stays in platform account, fee tracked in DB only`);
    }

    const paymentIntent = await stripe.paymentIntents.create(
      piParams,
      { idempotencyKey: `pi-${req.userId}-${orderId}` }
    );

    // Mark order as payment-pending (PI created, awaiting card confirmation)
    await WorkHoursOrder.findByIdAndUpdate(orderId, {
      stripePaymentIntentId: paymentIntent.id,
      paymentStatus:         'pending',
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      amount:       order.order_sum,
      tradeName:    order.trade_id.fullName,
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/stripe/create-deposit-intent ───────────────────────────────────
// Creates a PaymentIntent with capture_method:'manual' — authorizes (holds) the
// card but does NOT charge it. Call stripe.paymentIntents.capture() later to settle.
export async function createDepositIntent(req, res, next) {
  try {
    const { siteId, messageId, amount } = req.body;
    const isDirect = !!messageId && !siteId;
    console.log(`\n[createDepositIntent] siteId=${siteId||'(none)'} messageId=${messageId||'(none)'} amount=${amount} contractorId=${req.userId}`);

    if ((!siteId && !messageId) || !amount || amount <= 0) {
      return res.status(400).json({ message: 'siteId or messageId, and amount are required' });
    }

    const contractor = await Contractor.findById(req.userId)
      .select('email companyName stripeCustomerId').lean();

    let customerId = contractor.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: contractor.email,
        name:  contractor.companyName,
        metadata: { contractorId: String(contractor._id) },
      });
      customerId = customer.id;
      await Contractor.findByIdAndUpdate(req.userId, { stripeCustomerId: customerId });
    }

    const amountCents = Math.round(amount * 100);
    const msgFilter   = isDirect
      ? { _id: messageId, contractor: req.userId }
      : { site: siteId,  contractor: req.userId };

    // Reuse an existing valid PI if one exists, otherwise cancel the stale one
    const existingMsg = await Message.findOne({
      ...msgFilter,
      stripeDepositIntentId: { $ne: null },
    }).lean();

    if (existingMsg?.stripeDepositIntentId) {
      try {
        const existing = await stripe.paymentIntents.retrieve(existingMsg.stripeDepositIntentId);
        console.log(`[createDepositIntent] found existing PI ${existing.id} status=${existing.status}`);
        const reusable = ['requires_payment_method', 'requires_confirmation', 'requires_action'];
        if (reusable.includes(existing.status) && existing.payment_method_types?.includes('card')) {
          console.log(`[createDepositIntent] reusing valid PI`);
          return res.json({ clientSecret: existing.client_secret, amount });
        }
        if (!['succeeded', 'canceled'].includes(existing.status)) {
          await stripe.paymentIntents.cancel(existing.id);
          console.log(`[createDepositIntent] cancelled stale PI ${existing.id}`);
        }
      } catch (e) {
        console.log(`[createDepositIntent] could not retrieve existing PI: ${e.message}`);
      }
      await Message.updateMany(msgFilter, { $unset: { stripeDepositIntentId: '', depositStatus: '' } });
    }

    const refKey = isDirect ? String(messageId) : String(siteId);
    const paymentIntent = await stripe.paymentIntents.create({
      amount:               amountCents,
      currency:             'usd',
      customer:             customerId,
      capture_method:       'manual',
      payment_method_types: ['card'],
      setup_future_usage:   'off_session',
      metadata: {
        ...(isDirect ? { messageId: refKey } : { siteId: refKey }),
        contractorId: String(req.userId),
        type:         'deposit',
      },
      description: isDirect
        ? `TradeLink — Direct booking deposit hold (message ${refKey})`
        : `TradeLink — Deposit hold for project ${refKey}`,
    });

    console.log(`[createDepositIntent] PI created — id=${paymentIntent.id} status=${paymentIntent.status} amountCents=${amountCents}`);

    // Stamp the PI ID onto relevant messages
    const stampFilter = isDirect
      ? { _id: messageId, contractor: req.userId }
      : { site: siteId, contractor: req.userId, type: { $in: ['approval', 'worker_offer'] }, status: 'approved' };

    const stampResult = await Message.updateMany(
      stampFilter,
      { stripeDepositIntentId: paymentIntent.id, depositStatus: 'pending' }
    );
    console.log(`[createDepositIntent] stamped ${stampResult.modifiedCount}/${stampResult.matchedCount} messages`);

    res.json({ clientSecret: paymentIntent.client_secret, amount });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/stripe/webhook ──────────────────────────────────────────────────
// MUST be registered with express.raw({ type: 'application/json' }) — see app.js.
// Verifies Stripe signature (rule #5) then updates order paymentStatus.
export async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,                              // raw Buffer
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[Stripe webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const pi      = event.data.object;
  const orderId = pi.metadata?.orderId;
  const amount  = pi.amount != null ? `$${(pi.amount / 100).toFixed(2)}` : '';
  const piId    = pi.id ?? '';

  try {
    switch (event.type) {

      case 'payment_intent.created':
        console.log(`\n💳 [Stripe] payment_intent.created`);
        console.log(`   PI ID   : ${piId}`);
        console.log(`   Amount  : ${amount}`);
        console.log(`   Order   : ${orderId ?? '—'}`);
        break;

      case 'charge.succeeded':
        console.log(`\n✅ [Stripe] charge.succeeded`);
        console.log(`   Charge  : ${pi.id ?? ''}`);
        console.log(`   Amount  : $${((pi.amount ?? 0) / 100).toFixed(2)}`);
        console.log(`   Email   : ${pi.billing_details?.email ?? pi.receipt_email ?? '—'}`);
        break;

      case 'payment_intent.succeeded': {
        console.log(`\n🎉 [Stripe] payment_intent.succeeded`);
        console.log(`   PI ID       : ${piId}`);
        console.log(`   Order       : ${orderId ?? '—'}`);

        if (orderId) {
          // Fetch order first — order_sum is the authoritative base for fee calculation
          const existing = await WorkHoursOrder.findById(orderId).lean();

          // Idempotency — skip only when the full flow (payment + email) already completed
          if (existing?.receiptSent === true) {
            console.log(`   DB          : receipt already sent — skipping duplicate webhook`);
            break;
          }

          // Calculate fee from order_sum; never rely on PI metadata for amounts
          const orderSum      = existing?.order_sum ?? 0;
          const feeDollars    = parseFloat((orderSum * PLATFORM_FEE_PERCENT / 100).toFixed(2));
          const payoutDollars = parseFloat((orderSum - feeDollars).toFixed(2));

          console.log(`   Order sum   : $${orderSum}`);
          console.log(`   Fee (${PLATFORM_FEE_PERCENT}%)   : $${feeDollars}  (fee_sum)`);
          console.log(`   TradePro    : $${payoutDollars}  (payment_sum)`);

          // Mark paid; flag receipt as pending
          await WorkHoursOrder.findByIdAndUpdate(orderId, {
            paymentStatus: 'paid',
            payment_sum:   payoutDollars,
            fee_sum:       feeDollars,
            receiptSent:   false,
          });
          console.log(`   DB          : paymentStatus → paid ✅  |  payment_sum=$${payoutDollars}  fee_sum=$${feeDollars}`);

          // Send receipt email to contractor
          const order = await WorkHoursOrder.findById(orderId)
            .populate('contractor_id', 'companyName email')
            .populate('trade_id',      'fullName')
            .populate('site_id',       'name')
            .lean();

          const contractorEmail = order?.contractor_id?.email;
          if (contractorEmail) {
            const companyName    = order.contractor_id?.companyName ?? 'Contractor';
            const tradeName      = order.trade_id?.fullName ?? 'Trade Pro';
            const siteName       = order.site_id?.name ?? '—';
            const totalCharged   = orderSum;
            const displayDate    = order.date
              ? new Date(order.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
              : '—';

            const subject = `🧾 Payment Receipt — ${tradeName} · ${siteName} — TradeLink`;
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
          <td style="color:#0f172a;font-size:13px;font-weight:700;text-align:right;padding:8px 0 4px">$${order.order_sum}</td>
        </tr>
        <tr><td style="color:#475569;font-size:13px;padding:4px 0">Platform Fee</td><td style="color:#64748b;font-size:13px;text-align:right">$${feeDollars}</td></tr>
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

            await sendMail({ to: contractorEmail, subject, html });
            await WorkHoursOrder.findByIdAndUpdate(orderId, { receiptSent: true });
            console.log(`   Email       : receipt sent to ${contractorEmail} ✅`);
          }
        }
        break;
      }

      case 'charge.updated':
        console.log(`\n🔄 [Stripe] charge.updated`);
        console.log(`   Charge  : ${pi.id ?? ''}`);
        console.log(`   Status  : ${pi.status ?? '—'}`);
        console.log(`   Amount  : $${((pi.amount ?? 0) / 100).toFixed(2)}`);
        break;

      // ── Deposit hold authorized (manual capture PI) ──────────────────────
      case 'payment_intent.amount_capturable_updated': {
        const depositType = pi.metadata?.type;
        const depositSite = pi.metadata?.siteId;
        if (depositType === 'deposit' && depositSite) {
          await Message.updateMany(
            { stripeDepositIntentId: piId, type: 'approval' },
            { depositStatus: 'held' }
          );
          console.log(`\n🔒 [Stripe] deposit held for site ${depositSite} | PI: ${piId}`);
        }
        break;
      }

      case 'payment_intent.payment_failed':
        console.warn(`\n❌ [Stripe] payment_intent.payment_failed`);
        console.warn(`   PI ID   : ${piId}`);
        console.warn(`   Reason  : ${pi.last_payment_error?.message ?? '—'}`);
        console.warn(`   Order   : ${orderId ?? '—'}`);
        if (orderId) {
          await WorkHoursOrder.findByIdAndUpdate(orderId, { paymentStatus: 'failed' });
          console.warn(`   DB      : paymentStatus → failed`);
        }
        break;

      // ── Stripe Custom account verification complete ───────────────────────
      case 'account.updated': {
        const acct = event.data.object;
        if (acct.charges_enabled && acct.details_submitted) {
          const updated = await TradePro.findOneAndUpdate(
            { stripeAccountId: acct.id, stripeOnboarded: false },
            { stripeOnboarded: true },
            { new: true }
          );
          if (updated) {
            console.log(`\n✅ [Stripe] account.updated — ${acct.id} now verified`);
            console.log(`   TradePro : ${updated.email} → stripeOnboarded: true`);
          }
        }
        break;
      }

      default:
        // Silently ignore all other event types
        break;
    }
  } catch (err) {
    console.error('[Stripe webhook] DB update failed:', err.message);
    // Still return 200 so Stripe doesn't retry — we log the error
  }

  res.json({ received: true });
}
