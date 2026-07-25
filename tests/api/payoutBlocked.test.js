import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../app.js';
import {
  createContractor, createTradePro, createSite, createWorkHoursOrder,
  asTrade, asContractor,
} from '../helpers/factories.js';

const ENDPOINT = '/api/trade/payout-blocked';

// This endpoint is the only way a trade pro learns their money is stuck, so the
// filter that decides what counts as "blocked" is pinned tightly — a false
// negative here means a silent unpaid job.
describe(`GET ${ENDPOINT}`, () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get(ENDPOINT);
    expect(res.status).toBe(401);
  });

  it('rejects a contractor token — trade accounts only', async () => {
    const contractor = await createContractor();
    const res = await request(app).get(ENDPOINT).set(asContractor(contractor));
    expect(res.status).toBe(403);
  });

  it('returns blocked:false when nothing is stuck', async () => {
    const trade = await createTradePro();
    const res   = await request(app).get(ENDPOINT).set(asTrade(trade));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ blocked: false });
  });

  it('reports a blocked payout with the site, amount and reason', async () => {
    const contractor = await createContractor();
    const trade      = await createTradePro();
    const site       = await createSite(contractor, { name: 'Riverside Lofts' });

    await createWorkHoursOrder({
      contractor, tradePro: trade, site,
      date:                '2026-03-02',
      paymentStatus:       'failed',
      payment_sum:         360,
      payoutBlockedCode:   'no_bank_account',
      payoutBlockedReason: 'No bank account is attached to your payout account.',
    });

    const res = await request(app).get(ENDPOINT).set(asTrade(trade));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      blocked:   true,
      count:     1,
      totalOwed: 360,
      code:      'no_bank_account',
    });
    expect(res.body.jobs).toEqual([
      { site: 'Riverside Lofts', date: '2026-03-02', amount: 360 },
    ]);
  });

  it('sums what is owed across several blocked jobs', async () => {
    const contractor = await createContractor();
    const trade      = await createTradePro();
    const site       = await createSite(contractor);

    const blocked = {
      paymentStatus:       'failed',
      payoutBlockedCode:   'no_bank_account',
      payoutBlockedReason: 'No bank account attached.',
    };
    await createWorkHoursOrder({ contractor, tradePro: trade, site, ...blocked, payment_sum: 120.55 });
    await createWorkHoursOrder({ contractor, tradePro: trade, site, ...blocked, payment_sum: 80.20 });

    const res = await request(app).get(ENDPOINT).set(asTrade(trade));

    expect(res.body.count).toBe(2);
    // Rounded, not 200.74999999999997
    expect(res.body.totalOwed).toBe(200.75);
  });

  it('ignores orders belonging to a different trade pro', async () => {
    const contractor = await createContractor();
    const mine       = await createTradePro();
    const theirs     = await createTradePro();
    const site       = await createSite(contractor);

    await createWorkHoursOrder({
      contractor, tradePro: theirs, site,
      paymentStatus: 'failed', payment_sum: 500,
      payoutBlockedCode: 'no_bank_account', payoutBlockedReason: 'x',
    });

    const res = await request(app).get(ENDPOINT).set(asTrade(mine));
    expect(res.body).toEqual({ blocked: false });
  });

  it.each([
    ['paid',    { paymentStatus: 'paid'    }],
    ['pending', { paymentStatus: 'pending' }],
    ['unpaid',  { paymentStatus: 'unpaid'  }],
  ])('does not report an order whose paymentStatus is %s', async (_label, patch) => {
    const contractor = await createContractor();
    const trade      = await createTradePro();
    const site       = await createSite(contractor);

    await createWorkHoursOrder({
      contractor, tradePro: trade, site,
      payment_sum: 100, payoutBlockedCode: 'no_bank_account', payoutBlockedReason: 'x',
      ...patch,
    });

    const res = await request(app).get(ENDPOINT).set(asTrade(trade));
    expect(res.body).toEqual({ blocked: false });
  });

  it('does not report a failed order that carries no block code', async () => {
    // A generic failure with no diagnosed cause has no actionable message to
    // show, so it must not trigger the "check your bank account" prompt.
    const contractor = await createContractor();
    const trade      = await createTradePro();
    const site       = await createSite(contractor);

    await createWorkHoursOrder({
      contractor, tradePro: trade, site,
      paymentStatus: 'failed', payment_sum: 100, payoutBlockedCode: null,
    });

    const res = await request(app).get(ENDPOINT).set(asTrade(trade));
    expect(res.body).toEqual({ blocked: false });
  });

  it('does not report a blocked order that was never approved', async () => {
    const contractor = await createContractor();
    const trade      = await createTradePro();
    const site       = await createSite(contractor);

    await createWorkHoursOrder({
      contractor, tradePro: trade, site,
      status: 'pending', paymentStatus: 'failed', payment_sum: 100,
      payoutBlockedCode: 'no_bank_account', payoutBlockedReason: 'x',
    });

    const res = await request(app).get(ENDPOINT).set(asTrade(trade));
    expect(res.body).toEqual({ blocked: false });
  });

  it('falls back to a dash when the order has no site', async () => {
    const contractor = await createContractor();
    const trade      = await createTradePro();

    await createWorkHoursOrder({
      contractor, tradePro: trade, site: null,
      paymentStatus: 'failed', payment_sum: 75,
      payoutBlockedCode: 'no_account', payoutBlockedReason: 'No payout account connected yet.',
    });

    const res = await request(app).get(ENDPOINT).set(asTrade(trade));
    expect(res.body.jobs[0].site).toBe('—');
  });
});
