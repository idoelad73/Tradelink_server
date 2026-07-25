import jwt from 'jsonwebtoken';
import Contractor     from '../../models/Contractor.js';
import TradePro       from '../../models/TradePro.js';
import Site           from '../../models/Site.js';
import Message        from '../../models/Message.js';
import WorkHoursOrder from '../../models/WorkHoursOrder.js';

// Unique-email counter so a test can create several users without colliding on
// the unique index.
let seq = 0;
const uniq = (prefix) => `${prefix}${++seq}@test.local`;

export const TEST_PASSWORD = 'Passw0rd!';

export async function createContractor(overrides = {}) {
  return Contractor.create({
    companyName: 'Acme Builders',
    email:       uniq('contractor'),
    password:    TEST_PASSWORD,
    phone:       '5550100',
    address:     '1 Main St, New York, NY',
    ...overrides,
  });
}

export async function createAdmin(overrides = {}) {
  return createContractor({ user_type: 'admin', ...overrides });
}

export async function createTradePro(overrides = {}) {
  return TradePro.create({
    fullName:        'Pat Tradesman',
    email:           uniq('trade'),
    password:        TEST_PASSWORD,
    phone:           '5550200',
    address:         '2 Main St, New York, NY',
    professionality: 'Painter',
    hourlyRate:      50,
    stripeAccountId: 'acct_ready',
    stripeOnboarded: true,
    ...overrides,
  });
}

export async function createSite(contractor, overrides = {}) {
  return Site.create({
    contractor: contractor._id,
    name:       'Downtown Tower',
    type:       'commercial',
    address:    '3 Main St, New York, NY',
    ...overrides,
  });
}

/**
 * The `payment`/`pending` Message that PATCH /payment-approvals/:orderId acts on.
 * Its `text` field is a JSON snapshot of the submitted work log — the controller
 * parses it for actual_hours / workers_no, so it must be a JSON string.
 */
export async function createPendingPaymentMessage({
  contractor, tradePro, site,
  actualHours = 8, workersNo = 1, date = '2026-03-02',
  ...overrides
} = {}) {
  return Message.create({
    tradePro:      tradePro._id,
    site:          site?._id ?? null,
    contractor:    contractor._id,
    requestedDate: date,
    text: JSON.stringify({
      actual_hours: actualHours,
      workers_no:   workersNo,
      hourly_rate:  tradePro.hourlyRate,
    }),
    type:       'payment',
    status:     'pending',
    senderType: 'trade',
    ...overrides,
  });
}

/** The `deposited` Message that holds the contractor's escrow for a site. */
export async function createDepositMessage({
  contractor, tradePro, site, minDeposit = 10_000,
  depositIntentId = 'pi_test_deposit',
  ...overrides
} = {}) {
  return Message.create({
    tradePro:              tradePro._id,
    site:                  site?._id ?? null,
    contractor:            contractor._id,
    type:                  'payment',
    status:                'deposited',
    senderType:            'contractor',
    min_deposit:           minDeposit,
    stripeDepositIntentId: depositIntentId,
    depositStatus:         'held',
    ...overrides,
  });
}

export async function createWorkHoursOrder({ contractor, tradePro, site, ...overrides } = {}) {
  return WorkHoursOrder.create({
    contractor_id: contractor._id,
    trade_id:      tradePro._id,
    site_id:       site?._id ?? null,
    date:          '2026-03-02',
    actual_hours:  8,
    hourly_rate:   50,
    workers_no:    1,
    status:        'approved',
    ...overrides,
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/** Signs the same JWT shape `middleware/auth.js` expects. */
export function tokenFor(user, type) {
  return jwt.sign({ id: user._id.toString(), type }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

export const asContractor = (c) => ({ Authorization: `Bearer ${tokenFor(c, 'contractor')}` });
export const asTrade      = (t) => ({ Authorization: `Bearer ${tokenFor(t, 'trade')}` });
