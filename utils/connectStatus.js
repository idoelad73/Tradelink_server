import stripe from './stripe.js';
import TradePro from '../models/TradePro.js';

/**
 * Resolves whether a trade pro's Stripe Connect account is usable as a payment
 * destination.
 *
 * `TradePro.stripeOnboarded` is only a cached snapshot — it's written by the
 * onboarding-return handler and the account.updated webhook. If either is missed
 * (webhook not delivered in local dev, user closing the tab before the redirect
 * lands), the flag stays false forever even though the account is fully enabled
 * at Stripe. Every caller that gated purely on that boolean then silently treated
 * a perfectly good account as "not connected" — money stays in the platform
 * account and never splits to the trade pro.
 *
 * So: trust the cached flag when it's already true, and when it's false go ask
 * Stripe before concluding anything. A false-but-actually-enabled account is
 * self-healed back into the DB so the next call is cheap again.
 *
 * @param {{_id: any, stripeAccountId?: string|null, stripeOnboarded?: boolean}} pro
 * @returns {Promise<boolean>}
 */
export async function isConnectReady(pro) {
  if (!pro?.stripeAccountId) return false;
  if (pro.stripeOnboarded)   return true;

  try {
    const account   = await stripe.accounts.retrieve(pro.stripeAccountId);
    const onboarded = !!(account.charges_enabled && account.details_submitted);

    if (onboarded) {
      // Self-heal the stale cache so this lookup isn't repeated on every payment.
      await TradePro.findByIdAndUpdate(pro._id, { stripeOnboarded: true });
      console.log(`[connectStatus] ${pro.stripeAccountId} was enabled at Stripe but stripeOnboarded was false — flag corrected`);
    }
    return onboarded;
  } catch (err) {
    // Can't reach Stripe — fall back to the cached (false) value rather than
    // assuming an account is payable.
    console.error(`[connectStatus] could not verify ${pro.stripeAccountId}: ${err.message}`);
    return false;
  }
}
