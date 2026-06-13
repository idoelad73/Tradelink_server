import stripe from '../utils/stripe.js';
import WorkHoursOrder from '../models/WorkHoursOrder.js';
import Contractor     from '../models/Contractor.js';

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
      .populate('trade_id', 'fullName professionality')
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

    // ── Create PaymentIntent server-side (rule #7) ───────────────────────────
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount:   amountCents,
        currency: 'usd',
        customer: customerId,
        automatic_payment_methods: { enabled: true }, // enables Apple Pay, Google Pay + card
        metadata: {
          orderId:       String(order._id),
          contractorId:  String(order.contractor_id),
          tradeId:       String(order.trade_id._id),
          date:          order.date,
        },
        description: `TradeLink — ${order.trade_id.fullName} (${order.trade_id.professionality}) ${order.date}`,
      },
      // Idempotency key prevents duplicate charges on retries (rule #8)
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

      case 'payment_intent.succeeded':
        console.log(`\n🎉 [Stripe] payment_intent.succeeded`);
        console.log(`   PI ID   : ${piId}`);
        console.log(`   Amount  : ${amount}`);
        console.log(`   Order   : ${orderId ?? '—'}`);
        if (orderId) {
          await WorkHoursOrder.findByIdAndUpdate(orderId, { paymentStatus: 'paid' });
          console.log(`   DB      : paymentStatus → paid ✅`);
        }
        break;

      case 'charge.updated':
        console.log(`\n🔄 [Stripe] charge.updated`);
        console.log(`   Charge  : ${pi.id ?? ''}`);
        console.log(`   Status  : ${pi.status ?? '—'}`);
        console.log(`   Amount  : $${((pi.amount ?? 0) / 100).toFixed(2)}`);
        break;

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
