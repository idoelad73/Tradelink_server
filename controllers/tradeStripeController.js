import stripe   from '../utils/stripe.js';
import TradePro from '../models/TradePro.js';

// ── POST /api/trade/stripe/onboard ────────────────────────────────────────────
// Creates a Stripe Express account for the TradePro (if they don't have one yet)
// and returns a hosted onboarding URL.  The TradePro visits that URL, enters
// their bank/ID details on Stripe's pages, then Stripe redirects back to us.
export async function createOnboardingLink(req, res, next) {
  try {
    const pro = await TradePro.findById(req.userId).select('email fullName stripeAccountId stripeOnboarded').lean();
    if (!pro) return res.status(404).json({ message: 'TradePro not found' });

    // If already fully onboarded just return status
    if (pro.stripeOnboarded) {
      return res.json({ alreadyOnboarded: true });
    }

    // Re-use existing Express account or create a new one
    let accountId = pro.stripeAccountId;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type:  'express',
        email: pro.email,
        capabilities: {
          card_payments: { requested: true },
          transfers:     { requested: true },
        },
        business_profile: { name: pro.fullName },
        metadata: { tradeProId: String(pro._id) },
      });
      accountId = account.id;
      await TradePro.findByIdAndUpdate(req.userId, { stripeAccountId: accountId });
    }

    // Generate a one-time onboarding link (expires in ~10 min)
    const origin = process.env.CLIENT_URL || 'http://localhost:5173';
    const accountLink = await stripe.accountLinks.create({
      account:     accountId,
      refresh_url: `${origin}/dashboard/trade?stripe=refresh`,  // user must restart
      return_url:  `${origin}/dashboard/trade?stripe=return`,   // onboarding complete
      type:        'account_onboarding',
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/trade/stripe/onboard/complete ───────────────────────────────────
// Called by the client after Stripe redirects back with ?stripe=return.
// Checks whether the account now has charges_enabled = true and updates DB.
export async function completeOnboarding(req, res, next) {
  try {
    const pro = await TradePro.findById(req.userId).select('stripeAccountId stripeOnboarded').lean();
    if (!pro?.stripeAccountId) {
      return res.status(400).json({ message: 'No Stripe account found — start onboarding first' });
    }

    const account = await stripe.accounts.retrieve(pro.stripeAccountId);
    const onboarded = account.charges_enabled && account.details_submitted;

    if (onboarded && !pro.stripeOnboarded) {
      await TradePro.findByIdAndUpdate(req.userId, { stripeOnboarded: true });
    }

    console.log(`[Stripe Connect] TradePro ${req.userId} — charges_enabled: ${account.charges_enabled}, details_submitted: ${account.details_submitted}`);

    res.json({ onboarded, chargesEnabled: account.charges_enabled });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/trade/stripe/status ──────────────────────────────────────────────
// Returns current Connect onboarding status for the TradePro dashboard.
export async function getStripeStatus(req, res, next) {
  try {
    const pro = await TradePro.findById(req.userId).select('stripeAccountId stripeOnboarded').lean();
    res.json({
      onboarded:  pro?.stripeOnboarded  ?? false,
      accountId:  pro?.stripeAccountId  ?? null,
    });
  } catch (err) {
    next(err);
  }
}
