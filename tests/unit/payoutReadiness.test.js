import { describe, it, expect, vi, afterAll } from 'vitest';
import { stripeMock } from '../mocks/stripe.js';

/**
 * `IS_TEST_MODE` is evaluated once at module load from STRIPE_SECRET_KEY, so the
 * two modes can only be exercised by re-importing the module under a different
 * key. vi.mock registrations survive resetModules, so the stripe fake stays in
 * place across both loads.
 */
async function loadUnderKey(secretKey) {
  vi.resetModules();
  process.env.STRIPE_SECRET_KEY = secretKey;
  const { verifyPayoutReady } = await import('../../utils/payoutReadiness.js');
  return verifyPayoutReady;
}

const HARNESS_KEY = process.env.STRIPE_SECRET_KEY;
afterAll(() => { process.env.STRIPE_SECRET_KEY = HARNESS_KEY; });

const LIVE = 'sk_live_fake';
const TEST = 'sk_test_fake';

// This gate is the only thing standing between a contractor's approval and money
// disappearing into a connected account that can't pay out, so every branch is
// pinned — including which reason wins when several apply at once.
describe('verifyPayoutReady — mode-independent behaviour', () => {
  it('reports no_account when the trade pro never connected Stripe', async () => {
    const verifyPayoutReady = await loadUnderKey(LIVE);
    const result = await verifyPayoutReady(null);

    expect(result).toMatchObject({ ready: false, code: 'no_account' });
    expect(result.message).toMatch(/bank details/i);
    // Must not waste a Stripe round-trip on an ID we know is absent.
    expect(stripeMock.accounts.retrieve).not.toHaveBeenCalled();
  });

  it('trusts payouts_enabled and returns ready without inspecting sub-fields', async () => {
    // Deliberately hostile shape: no bank attached, requirements outstanding.
    // payouts_enabled is Stripe's authoritative verdict and must win anyway,
    // otherwise a healthy account gets wrongly blocked.
    const verifyPayoutReady = await loadUnderKey(LIVE);
    stripeMock.accounts.retrieve.mockResolvedValueOnce({
      payouts_enabled:   true,
      external_accounts: { data: [] },
      requirements:      { currently_due: ['individual.id_number'], past_due: ['individual.ssn_last_4'] },
    });

    expect(await verifyPayoutReady('acct_1')).toEqual({ ready: true });
  });

  it('reports no_bank_account when nothing is attached', async () => {
    const verifyPayoutReady = await loadUnderKey(LIVE);
    stripeMock.accounts.retrieve.mockResolvedValueOnce({
      payouts_enabled:   false,
      external_accounts: { data: [] },
    });

    expect(await verifyPayoutReady('acct_1')).toMatchObject({ ready: false, code: 'no_bank_account' });
  });

  it('reports no_bank_account when external_accounts is not expanded at all', async () => {
    const verifyPayoutReady = await loadUnderKey(LIVE);
    stripeMock.accounts.retrieve.mockResolvedValueOnce({ payouts_enabled: false });

    expect(await verifyPayoutReady('acct_1')).toMatchObject({ code: 'no_bank_account' });
  });

  it('surfaces past-due requirements once a verified bank exists', async () => {
    const verifyPayoutReady = await loadUnderKey(LIVE);
    stripeMock.accounts.retrieve.mockResolvedValueOnce({
      payouts_enabled:   false,
      external_accounts: { data: [{ status: 'verified', last4: '4242' }] },
      requirements:      { past_due: ['individual.ssn_last_4'], currently_due: ['individual.id_number'] },
    });

    const result = await verifyPayoutReady('acct_1');

    expect(result).toMatchObject({ ready: false, code: 'requirements_past_due' });
    expect(result.requirements).toEqual(['individual.ssn_last_4']);
  });

  it('falls back to payouts_disabled and includes the disabled_reason', async () => {
    const verifyPayoutReady = await loadUnderKey(LIVE);
    stripeMock.accounts.retrieve.mockResolvedValueOnce({
      payouts_enabled:   false,
      external_accounts: { data: [{ status: 'verified', last4: '4242' }] },
      requirements:      { currently_due: ['individual.id_number'], disabled_reason: 'requirements.pending_verification' },
    });

    const result = await verifyPayoutReady('acct_1');

    expect(result).toMatchObject({ ready: false, code: 'payouts_disabled' });
    expect(result.requirements).toEqual(['individual.id_number']);
    expect(result.message).toContain('requirements.pending_verification');
  });

  it('degrades to a blocked result — never a throw — when Stripe itself errors', async () => {
    // A throw here would escape into updatePaymentApproval and 500 an approval
    // that already succeeded, so the failure has to come back as a value.
    const verifyPayoutReady = await loadUnderKey(LIVE);
    stripeMock.accounts.retrieve.mockRejectedValueOnce(new Error('No such account: acct_gone'));

    const result = await verifyPayoutReady('acct_gone');

    expect(result).toMatchObject({ ready: false, code: 'stripe_error' });
    expect(result.message).toContain('No such account: acct_gone');
  });
});

// ── The unverified-bank branch is mode-dependent ─────────────────────────────
// Under a live key an unverifiable bank blocks the payout. Under a test key it
// is let through, because Stripe's own fixture bank numbers are designed to sit
// in errored/verification_failed forever and would otherwise make the paid path
// impossible to exercise end-to-end.
describe('verifyPayoutReady — unverified bank under a LIVE key', () => {
  it('blocks a bank that failed verification, quoting its last4', async () => {
    const verifyPayoutReady = await loadUnderKey(LIVE);
    stripeMock.accounts.retrieve.mockResolvedValueOnce({
      payouts_enabled:   false,
      external_accounts: { data: [{ status: 'verification_failed', last4: '6789' }] },
    });

    const result = await verifyPayoutReady('acct_1');

    expect(result).toMatchObject({ ready: false, code: 'bank_verification_failed' });
    expect(result.message).toContain('6789');
  });

  it('blocks an errored bank the same way', async () => {
    const verifyPayoutReady = await loadUnderKey(LIVE);
    stripeMock.accounts.retrieve.mockResolvedValueOnce({
      payouts_enabled:   false,
      external_accounts: { data: [{ status: 'errored', last4: '1111' }] },
    });

    expect(await verifyPayoutReady('acct_1')).toMatchObject({ code: 'bank_verification_failed' });
  });

  it('prefers the unverified-bank reason over outstanding requirements', async () => {
    // Both apply; the bank problem is the one the trade pro can actually act on.
    const verifyPayoutReady = await loadUnderKey(LIVE);
    stripeMock.accounts.retrieve.mockResolvedValueOnce({
      payouts_enabled:   false,
      external_accounts: { data: [{ status: 'verification_failed', last4: '2222' }] },
      requirements:      { past_due: ['individual.ssn_last_4'] },
    });

    expect(await verifyPayoutReady('acct_1')).toMatchObject({ code: 'bank_verification_failed' });
  });

  it('still lets an explicitly-named Stripe test bank through', async () => {
    const verifyPayoutReady = await loadUnderKey(LIVE);
    stripeMock.accounts.retrieve.mockResolvedValueOnce({
      payouts_enabled:   false,
      external_accounts: { data: [{ status: 'errored', last4: '1116', bank_name: 'STRIPE TEST BANK' }] },
      requirements:      { past_due: ['individual.ssn_last_4'] },
    });

    // Falls through the bank check to the next applicable reason.
    expect(await verifyPayoutReady('acct_1')).toMatchObject({ code: 'requirements_past_due' });
  });
});

describe('verifyPayoutReady — unverified bank under a TEST key', () => {
  it('does not treat an unverifiable bank as a blocked payout', async () => {
    const verifyPayoutReady = await loadUnderKey(TEST);
    stripeMock.accounts.retrieve.mockResolvedValueOnce({
      payouts_enabled:   false,
      external_accounts: { data: [{ status: 'verification_failed', last4: '6789' }] },
      requirements:      { currently_due: [] },
    });

    const result = await verifyPayoutReady('acct_1');

    expect(result.code).not.toBe('bank_verification_failed');
    expect(result).toMatchObject({ ready: false, code: 'payouts_disabled' });
  });

  it('is still not "ready" — the account remains payout-disabled', async () => {
    // The bypass only skips the bank_verification_failed *reason*; it must not
    // manufacture a ready:true verdict for an account Stripe says cannot pay out.
    const verifyPayoutReady = await loadUnderKey(TEST);
    stripeMock.accounts.retrieve.mockResolvedValueOnce({
      payouts_enabled:   false,
      external_accounts: { data: [{ status: 'errored', last4: '1116' }] },
    });

    expect((await verifyPayoutReady('acct_1')).ready).toBe(false);
  });
});
