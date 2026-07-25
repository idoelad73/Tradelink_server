import { vi } from 'vitest';

/**
 * Controllable fake of `utils/stripe.js`.
 *
 * Defaults describe the happy path (payout-ready account, transfers succeed) so
 * a test only has to override the one call it is actually about. Reach for
 * `stripeMock.accounts.retrieve.mockResolvedValueOnce(...)` to drive a specific
 * Stripe state rather than rewriting the whole object.
 */
export const stripeMock = {
  accounts: {
    retrieve: vi.fn(),
  },
  transfers: {
    create: vi.fn(),
  },
  paymentIntents: {
    create:   vi.fn(),
    retrieve: vi.fn(),
    capture:  vi.fn(),
  },
  accountLinks: {
    create: vi.fn(),
  },
};

/** A connected account Stripe considers able to receive payouts. */
export const PAYOUT_READY_ACCOUNT = {
  id:              'acct_ready',
  payouts_enabled: true,
  charges_enabled: true,
};

/** Restores every stripe call to its happy-path default. Called before each test. */
export function resetStripeMock() {
  stripeMock.accounts.retrieve.mockReset().mockResolvedValue(PAYOUT_READY_ACCOUNT);

  stripeMock.transfers.create.mockReset().mockImplementation(async ({ amount }) => ({
    id:     `tr_test_${amount}`,
    amount,
    object: 'transfer',
  }));

  stripeMock.paymentIntents.create.mockReset().mockImplementation(async ({ amount }) => ({
    id:            'pi_test_created',
    amount,
    status:        'succeeded',
    client_secret: 'pi_test_created_secret',
    latest_charge: 'ch_test_created',
  }));

  stripeMock.paymentIntents.retrieve.mockReset().mockResolvedValue({
    id:            'pi_test_deposit',
    status:        'requires_capture',
    amount:        100_000,
    latest_charge: 'ch_test_deposit',
  });

  stripeMock.paymentIntents.capture.mockReset().mockResolvedValue({
    id:            'pi_test_deposit',
    status:        'succeeded',
    latest_charge: 'ch_test_deposit',
  });
}

export default stripeMock;
