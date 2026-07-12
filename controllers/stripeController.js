import stripe       from '../utils/stripe.js';
import WorkHoursOrder from '../models/WorkHoursOrder.js';
import Contractor     from '../models/Contractor.js';
import TradePro       from '../models/TradePro.js';
import Message        from '../models/Message.js';
import { sendMail }  from '../utils/mailer.js';
import { contractorReceiptEmail } from '../email_templates/paymentReceipt.js';
import { contractorReceiptPdf } from '../email_templates/receiptPdf.js';

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

            const receiptFields = {
              contractorName: companyName,
              tradeName,
              siteName,
              displayDate,
              actualHours: order.actual_hours,
              workersNo:   order.workers_no,
              hourlyRate:  order.hourly_rate,
              orderSum:    order.order_sum,
              feePercent:  PLATFORM_FEE_PERCENT,
              feeDollars,
            };

            const { subject, html } = contractorReceiptEmail(receiptFields);
            const pdf = await contractorReceiptPdf(receiptFields);

            await sendMail({
              to: contractorEmail, subject, html,
              attachments: [{ filename: 'TradeLink-Receipt.pdf', content: pdf }],
            });
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
