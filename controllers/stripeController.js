import stripe       from '../utils/stripe.js';
import WorkHoursOrder from '../models/WorkHoursOrder.js';
import Contractor     from '../models/Contractor.js';
import TradePro       from '../models/TradePro.js';
import Message        from '../models/Message.js';
import { issueOrderReceipts } from '../utils/receipts.js';

// Platform fee % read from .env — e.g. STRIPE_PLATFORM_FEE_PERCENT=5  means 5%
const PLATFORM_FEE_PERCENT = parseFloat(process.env.STRIPE_PLATFORM_FEE_PERCENT ?? '0');

// NOTE: the former `createPaymentIntent` (full-amount charge-split) endpoint was
// removed. The live settlement flow is deposit-hold → approval → transfer the
// deposit + charge the overage difference (contractorController.updatePaymentApproval);
// nothing in the client ever called the full-charge endpoint, and leaving it live
// was a dormant second settlement path (QA finding #10).

// ── POST /api/stripe/create-deposit-intent ───────────────────────────────────
// Creates a PaymentIntent with capture_method:'manual' — authorizes (holds) the
// card but does NOT charge it. Call stripe.paymentIntents.capture() later to settle.
export async function createDepositIntent(req, res, next) {
  try {
    const { siteId, messageId, amount } = req.body;
    const isDirect = !!messageId && !siteId;
    console.log(`\n[createDepositIntent] siteId=${siteId||'(none)'} messageId=${messageId||'(none)'} amount=${amount} contractorId=${req.userId}`);

    // Coerce + bound the amount. It was taken as-is from the body, so a string,
    // NaN, zero, negative, or absurd value flowed straight into the hold and the
    // later payout/overage math (finding #8). The upper bound is a sanity cap,
    // not a business rule — see the note about deriving it from the booking.
    const amt = Number(amount);
    const MAX_DEPOSIT = 1_000_000;
    if ((!siteId && !messageId) || !Number.isFinite(amt) || amt <= 0 || amt > MAX_DEPOSIT) {
      return res.status(400).json({ message: 'siteId or messageId, and a valid amount are required' });
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

    const amountCents = Math.round(amt * 100);
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
          return res.json({ clientSecret: existing.client_secret, amount: amt });
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

    res.json({ clientSecret: paymentIntent.client_secret, amount: amt });
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
        // Cardholder email intentionally not logged (PII — finding #6).
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

          // Issue receipts through the shared path so this route produces the
          // same numbered, ledger-backed records as the approval flow. This
          // branch used to send a lone unnumbered PDF to the contractor and
          // write nothing to the Receipt collection, so what a contractor ended
          // up holding depended on which payment route they took.
          const order = await WorkHoursOrder.findById(orderId)
            .populate('contractor_id', 'companyName email')
            .populate('trade_id',      'fullName professionality email')
            .populate('site_id',       'name address')
            .lean();

          const issued = await issueOrderReceipts({
            order,
            contractor:   order?.contractor_id,
            tradePro:     order?.trade_id,
            site:         order?.site_id,
            orderSum,
            feeDollars,
            payoutAmount: payoutDollars,
            feePercent:   PLATFORM_FEE_PERCENT,
          });

          if (issued.skipped) {
            console.log(`   Receipts    : already issued for this order — nothing sent`);
          } else {
            if (issued.contractor?.ok) {
              await WorkHoursOrder.findByIdAndUpdate(orderId, { receiptSent: true });
            }
            console.log(`   Receipts    : contractor=${issued.contractor?.ok ? '✅' : '❌'} trade=${issued.trade?.ok ? '✅' : '❌'}`);
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
    // Return 500 so Stripe RETRIES this event (with backoff, for ~3 days).
    // Previously this was swallowed with a 200: a transient DB failure during
    // payment_intent.succeeded left the order not marked paid, no receipt issued,
    // and NO retry and NO alert — money state silently drifted (finding #9).
    //
    // Safe to retry because every branch above is idempotent: payment_intent.
    // succeeded short-circuits on `receiptSent` and issues receipts through an
    // order-level guard; payment_failed / amount_capturable_updated / account.
    // updated are all no-op on replay. A signature failure is handled earlier
    // and still returns 400 (not retryable).
    console.error(`\n[Stripe webhook] ❌ processing failed — Stripe will retry`);
    console.error(`   event   : ${event.type}`);
    console.error(`   pi/obj  : ${piId}`);
    console.error(`   order   : ${orderId ?? '—'}`);
    console.error(`   message : ${err.message}`);
    console.error(`   stack   : ${err.stack}\n`);
    return res.status(500).json({ received: false, error: 'processing_failed' });
  }

  res.json({ received: true });
}
