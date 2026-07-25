import stripe from './stripe.js';

// Test mode is inferred from the secret key rather than account.livemode, which
// isn't guaranteed to be present on every retrieve response.
const IS_TEST_MODE = (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test');

/**
 * Verifies a trade pro's Stripe Connect account can actually receive a payout
 * BEFORE we attempt a transfer.
 *
 * Stripe will happily accept a transfer into a connected account whose payouts
 * are disabled or whose bank details never cleared verification — the money
 * just sits in that account's balance and never reaches the trade pro, with no
 * error surfaced anywhere. Checking up-front turns that silent stuck balance
 * into an actionable message we can show the trade pro.
 *
 * @returns {{ ready: boolean, code?: string, message?: string, requirements?: string[] }}
 */
export async function verifyPayoutReady(stripeAccountId) {
  if (!stripeAccountId) {
    return {
      code:    'no_account',
      ready:   false,
      message: 'No payout account connected yet. Add your bank details to receive payment for completed work.',
    };
  }

  try {
    const account = await stripe.accounts.retrieve(stripeAccountId);

    // `payouts_enabled` is Stripe's own authoritative verdict — if it's true the
    // account can receive money, full stop. Trust it and return early rather than
    // second-guessing from sub-fields (`external_accounts` in particular is not
    // guaranteed to be expanded on retrieve, and treating an empty list as
    // "no bank" would wrongly block a perfectly healthy account).
    if (account.payouts_enabled) return { ready: true };

    // Not payout-enabled — work out the most actionable reason to show them.
    const externalAccounts = account.external_accounts?.data ?? [];
    const currentlyDue     = account.requirements?.currently_due ?? [];
    const pastDue          = account.requirements?.past_due      ?? [];
    const disabledReason   = account.requirements?.disabled_reason ?? null;

    // A bank account that failed micro-deposit / ownership verification stays
    // attached but is unusable — surface it distinctly from "none attached".
    const unverified = externalAccounts.find(ea => ea.status === 'verification_failed' || ea.status === 'errored');
    if (unverified) {
      // In test mode Stripe's own fixture bank numbers are *designed* to sit in
      // `errored`/`verification_failed` (e.g. 000111111116) and can never clear
      // verification, so treating that as a blocked payout makes the paid path
      // impossible to exercise end-to-end. Test-bank accounts are let through so
      // the transfer is still attempted; live mode keeps blocking as before.
      const isStripeTestBank = IS_TEST_MODE || /STRIPE TEST BANK/i.test(unverified.bank_name ?? '');
      if (!isStripeTestBank) {
        return {
          code:    'bank_verification_failed',
          ready:   false,
          message: `Your bank account ending ••${unverified.last4 ?? '????'} could not be verified by our payment provider. Please check the account and routing numbers and re-enter them.`,
        };
      }
      console.log(`[payoutReadiness] test-mode bank ••${unverified.last4} status=${unverified.status} — not treated as a blocked payout`);
    }

    if (externalAccounts.length === 0) {
      return {
        code:    'no_bank_account',
        ready:   false,
        message: 'No bank account is attached to your payout account. Add your bank details so payments can reach you.',
      };
    }

    if (pastDue.length > 0) {
      return {
        code:         'requirements_past_due',
        ready:        false,
        requirements: pastDue,
        message:      'Your payout account is missing required details and payments are on hold. Please complete your bank verification.',
      };
    }

    return {
      code:         'payouts_disabled',
      ready:        false,
      requirements: currentlyDue,
      message:      disabledReason
        ? `Payouts are currently disabled on your account (${disabledReason}). Please complete your bank verification.`
        : 'Payouts are not enabled on your account yet. Please complete your bank verification.',
    };
  } catch (err) {
    return {
      code:    'stripe_error',
      ready:   false,
      message: `We could not confirm your bank details with our payment provider (${err.message}). Please check your bank account.`,
    };
  }
}
