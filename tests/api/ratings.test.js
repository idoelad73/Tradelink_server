import { describe, it, expect } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../app.js';
import TradeGrade from '../../models/TradeGrade.js';
import TradePro from '../../models/TradePro.js';
import Contractor from '../../models/Contractor.js';
import {
  createContractor, createTradePro, createSite, createWorkHoursOrder,
  asContractor, asTrade,
} from '../helpers/factories.js';

/** A contractor, a trade pro, a site and one approved order joining them. */
async function job(orderOverrides = {}) {
  const contractor = await createContractor();
  const tradePro   = await createTradePro();
  const site       = await createSite(contractor);
  const order      = await createWorkHoursOrder({ contractor, tradePro, site, ...orderOverrides });
  return { contractor, tradePro, site, order };
}

const rateTrade = (contractor, body) =>
  request(app).post('/api/contractor/trade-grades').set(asContractor(contractor)).send(body);

const rateContractor = (tradePro, body) =>
  request(app).post('/api/trade/contractor-grades').set(asTrade(tradePro)).send(body);

describe('POST /api/contractor/trade-grades — authorisation', () => {
  it('rejects an order belonging to a different contractor', async () => {
    const { tradePro, site, order } = await job();
    const outsider = await createContractor({ companyName: 'Rival Ltd' });

    const res = await rateTrade(outsider, {
      trade_id: tradePro._id, site_id: site._id, order_id: order._id,
      trade_grade: 1, review_text: 'Sabotage',
    });

    expect(res.status).toBe(404);
    expect(await TradeGrade.countDocuments({})).toBe(0);
    expect((await TradePro.findById(tradePro._id).lean()).avgGrade).toBeNull();
  });

  it('rejects a fabricated order_id', async () => {
    const contractor = await createContractor();
    const tradePro   = await createTradePro();

    const res = await rateTrade(contractor, {
      trade_id: tradePro._id, order_id: new mongoose.Types.ObjectId(), trade_grade: 1,
    });

    expect(res.status).toBe(404);
    expect(await TradeGrade.countDocuments({})).toBe(0);
  });

  it('rejects an order that was not approved', async () => {
    const { contractor, tradePro, site, order } = await job({ status: 'rejected' });

    const res = await rateTrade(contractor, {
      trade_id: tradePro._id, site_id: site._id, order_id: order._id, trade_grade: 5,
    });

    expect(res.status).toBe(404);
  });

  it('ignores a spoofed trade_id and grades whoever the order names', async () => {
    // The body is not trusted: the graded pro comes from the order itself, so
    // pointing trade_id at a bystander cannot touch their score.
    const { contractor, tradePro, site, order } = await job();
    const bystander = await createTradePro({ fullName: 'Uninvolved Pro' });

    await rateTrade(contractor, {
      trade_id: bystander._id, site_id: site._id, order_id: order._id, trade_grade: 1,
    }).expect(201);

    expect((await TradePro.findById(bystander._id).lean()).avgGrade).toBeNull();
    expect((await TradePro.findById(tradePro._id).lean()).avgGrade).toBe(1);
    expect(String((await TradeGrade.findOne({}).lean()).trade_id)).toBe(String(tradePro._id));
  });

  it('still rejects out-of-range grades', async () => {
    const { contractor, tradePro, site, order } = await job();
    for (const bad of [0, 6, -1, 'abc', null, undefined]) {
      const res = await rateTrade(contractor, {
        trade_id: tradePro._id, site_id: site._id, order_id: order._id, trade_grade: bad,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe('POST /api/trade/contractor-grades — authorisation', () => {
  it('rejects a contractor the trade pro never worked with', async () => {
    const contractor = await createContractor();
    const stranger   = await createTradePro();

    const res = await rateContractor(stranger, {
      contractor_id: contractor._id, order_id: new mongoose.Types.ObjectId(), trade_grade: 1,
    });

    expect(res.status).toBe(404);
    expect((await Contractor.findById(contractor._id).lean()).avgGrade).toBeNull();
  });

  it("rejects another pro's order", async () => {
    const { contractor, site, order } = await job();
    const outsider = await createTradePro({ fullName: 'Someone Else' });

    const res = await rateContractor(outsider, {
      contractor_id: contractor._id, site_id: site._id, order_id: order._id, trade_grade: 1,
    });

    expect(res.status).toBe(404);
  });

  it('ignores a spoofed contractor_id', async () => {
    const { contractor, tradePro, site, order } = await job();
    const bystander = await createContractor({ companyName: 'Uninvolved Co' });

    await rateContractor(tradePro, {
      contractor_id: bystander._id, site_id: site._id, order_id: order._id, trade_grade: 2,
    }).expect(201);

    expect((await Contractor.findById(bystander._id).lean()).avgGrade).toBeNull();
    expect((await Contractor.findById(contractor._id).lean()).avgGrade).toBe(2);
  });
});

describe('both directions coexist on one order', () => {
  it('keeps each review when both parties rate the same job', async () => {
    const { contractor, tradePro, site, order } = await job();

    await rateTrade(contractor, {
      trade_id: tradePro._id, site_id: site._id, order_id: order._id,
      trade_grade: 5, review_text: 'Outstanding work',
    }).expect(201);

    await rateContractor(tradePro, {
      contractor_id: contractor._id, site_id: site._id, order_id: order._id,
      trade_grade: 2, review_text: 'Paid late',
    }).expect(201);

    const docs = await TradeGrade.find({}).sort({ grade_type: 1 }).lean();
    expect(docs).toHaveLength(2);

    const byType = Object.fromEntries(docs.map(d => [d.grade_type, d]));
    expect(byType.trade.trade_grade).toBe(5);
    expect(byType.trade.review_text).toBe('Outstanding work');
    expect(byType.contractor.trade_grade).toBe(2);
    expect(byType.contractor.review_text).toBe('Paid late');
  });

  it('holds in the reverse submission order too', async () => {
    const { contractor, tradePro, site, order } = await job();

    await rateContractor(tradePro, {
      contractor_id: contractor._id, site_id: site._id, order_id: order._id,
      trade_grade: 1, review_text: 'Never paid',
    }).expect(201);

    await rateTrade(contractor, {
      trade_id: tradePro._id, site_id: site._id, order_id: order._id,
      trade_grade: 4, review_text: 'Good job',
    }).expect(201);

    expect(await TradeGrade.countDocuments({})).toBe(2);
    expect((await TradePro.findById(tradePro._id).lean()).avgGrade).toBe(4);
    expect((await Contractor.findById(contractor._id).lean()).avgGrade).toBe(1);
  });

  it('does not resurrect a rated job in the eligible list', async () => {
    const { contractor, tradePro, site, order } = await job();

    await rateTrade(contractor, {
      trade_id: tradePro._id, site_id: site._id, order_id: order._id, trade_grade: 5,
    }).expect(201);

    await rateContractor(tradePro, {
      contractor_id: contractor._id, site_id: site._id, order_id: order._id, trade_grade: 3,
    }).expect(201);

    const forContractor = await request(app)
      .get('/api/contractor/trade-grades/eligible').set(asContractor(contractor));
    const forTrade = await request(app)
      .get('/api/trade/contractor-grades/eligible').set(asTrade(tradePro));

    expect(forContractor.body.trades).toHaveLength(0);
    expect(forTrade.body.contractors).toHaveLength(0);
  });

  it('re-rating the same order updates in place, one row per direction', async () => {
    const { contractor, tradePro, site, order } = await job();
    const body = { trade_id: tradePro._id, site_id: site._id, order_id: order._id };

    await rateTrade(contractor, { ...body, trade_grade: 4 }).expect(201);
    await rateTrade(contractor, { ...body, trade_grade: 2 }).expect(201);

    expect(await TradeGrade.countDocuments({ grade_type: 'trade' })).toBe(1);
    const pro = await TradePro.findById(tradePro._id).lean();
    expect(pro.gradeCount).toBe(1);
    expect(pro.avgGrade).toBe(2);
  });
});

describe('avgGrade is scoped to the correct direction', () => {
  it("excludes grades the trade pro GAVE from their own score", async () => {
    const contractor = await createContractor();
    const tradePro   = await createTradePro();
    const site       = await createSite(contractor);

    const orderA = await createWorkHoursOrder({ contractor, tradePro, site });
    const orderB = await createWorkHoursOrder({ contractor, tradePro, site, date: '2026-04-01' });

    await rateTrade(contractor, { order_id: orderA._id, trade_grade: 5 }).expect(201);
    await rateTrade(contractor, { order_id: orderB._id, trade_grade: 5 }).expect(201);

    // The pro hands out a 1★ to the contractor — must not touch their own score.
    await rateContractor(tradePro, { order_id: orderA._id, trade_grade: 1 }).expect(201);
    // Force a recompute of the pro's average.
    await rateTrade(contractor, { order_id: orderB._id, trade_grade: 5 }).expect(201);

    const pro = await TradePro.findById(tradePro._id).lean();
    expect(pro.avgGrade).toBe(5);
    expect(pro.gradeCount).toBe(2);

    const c = await Contractor.findById(contractor._id).lean();
    expect(c.avgGrade).toBe(1);
    expect(c.gradeCount).toBe(1);
  });
});

describe('direct-hire jobs (no site) are gradable', () => {
  it('lists an order with site_id: null for the contractor', async () => {
    const contractor = await createContractor();
    const tradePro   = await createTradePro();
    const order      = await createWorkHoursOrder({ contractor, tradePro, site: null });

    const res = await request(app)
      .get('/api/contractor/trade-grades/eligible').set(asContractor(contractor)).expect(200);

    expect(res.body.trades).toHaveLength(1);
    expect(res.body.trades[0].site_id).toBeNull();
    expect(res.body.trades[0].site_name).toBeNull();
    expect(String(res.body.trades[0].order_id)).toBe(String(order._id));
  });

  it('accepts the rating and stores a null site', async () => {
    const contractor = await createContractor();
    const tradePro   = await createTradePro();
    const order      = await createWorkHoursOrder({ contractor, tradePro, site: null });

    await rateTrade(contractor, { order_id: order._id, trade_grade: 5 }).expect(201);

    const doc = await TradeGrade.findOne({}).lean();
    expect(doc.site_id).toBeNull();
    expect((await TradePro.findById(tradePro._id).lean()).avgGrade).toBe(5);
  });

  it('still skips orders whose trade pro was deleted', async () => {
    const contractor = await createContractor();
    const tradePro   = await createTradePro();
    await createWorkHoursOrder({ contractor, tradePro, site: null });
    await TradePro.findByIdAndDelete(tradePro._id);

    const res = await request(app)
      .get('/api/contractor/trade-grades/eligible').set(asContractor(contractor)).expect(200);

    expect(res.body.trades).toHaveLength(0);
  });
});

/**
 * Ages a grade past the edit window. Goes through the raw driver because
 * Mongoose marks `createdAt` immutable and silently drops it from a $set.
 */
async function backdate(order, gradeType, hours = 25) {
  const res = await TradeGrade.collection.updateOne(
    { order_id: order._id, grade_type: gradeType },
    { $set: { createdAt: new Date(Date.now() - hours * 3_600_000) } },
  );
  expect(res.modifiedCount).toBe(1);   // guard against a silently no-op setup
}

describe('edit window', () => {
  it('allows a correction shortly after submitting and records it', async () => {
    const { contractor, tradePro, order } = await job();

    await rateTrade(contractor, { order_id: order._id, trade_grade: 2 }).expect(201);
    await rateTrade(contractor, { order_id: order._id, trade_grade: 5, review_text: 'Misclicked' }).expect(201);

    const doc = await TradeGrade.findOne({ grade_type: 'trade' }).lean();
    expect(doc.trade_grade).toBe(5);
    expect(doc.editCount).toBe(1);
    expect(doc.editedAt).toBeInstanceOf(Date);
    expect((await TradePro.findById(tradePro._id).lean()).avgGrade).toBe(5);
  });

  it('locks the rating once the window has passed', async () => {
    const { contractor, tradePro, order } = await job();
    await rateTrade(contractor, { order_id: order._id, trade_grade: 5 }).expect(201);

    await backdate(order, 'trade');

    const res = await rateTrade(contractor, { order_id: order._id, trade_grade: 1 });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/no longer be changed/);

    const doc = await TradeGrade.findOne({ grade_type: 'trade' }).lean();
    expect(doc.trade_grade).toBe(5);
    expect((await TradePro.findById(tradePro._id).lean()).avgGrade).toBe(5);
  });

  it('applies the same lock to the trade → contractor direction', async () => {
    const { contractor, tradePro, order } = await job();
    await rateContractor(tradePro, { order_id: order._id, trade_grade: 4 }).expect(201);

    await backdate(order, 'contractor');

    await rateContractor(tradePro, { order_id: order._id, trade_grade: 1 }).expect(409);
    expect((await Contractor.findById(contractor._id).lean()).avgGrade).toBe(4);
  });

  it("one side's lock does not block the other side's first rating", async () => {
    const { contractor, tradePro, order } = await job();
    await rateTrade(contractor, { order_id: order._id, trade_grade: 5 }).expect(201);

    await backdate(order, 'trade');

    await rateContractor(tradePro, { order_id: order._id, trade_grade: 3 }).expect(201);
  });
});

describe('review text and photos', () => {
  it('rejects review text over 500 characters', async () => {
    const { contractor, order } = await job();
    const res = await rateTrade(contractor, {
      order_id: order._id, trade_grade: 5, review_text: 'x'.repeat(501),
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/500 characters or fewer/);
    expect(await TradeGrade.countDocuments({})).toBe(0);
  });

  it('accepts exactly 500 characters', async () => {
    const { contractor, order } = await job();
    await rateTrade(contractor, {
      order_id: order._id, trade_grade: 5, review_text: 'y'.repeat(500),
    }).expect(201);

    expect((await TradeGrade.findOne({}).lean()).review_text).toHaveLength(500);
  });

  it('rejects "3abc" instead of storing it as 3', async () => {
    const { contractor, order } = await job();
    const res = await rateTrade(contractor, { order_id: order._id, trade_grade: '3abc' });

    expect(res.status).toBe(400);
    expect(await TradeGrade.countDocuments({})).toBe(0);
  });

  it('keeps only allowlisted photo hosts', async () => {
    const { contractor, order } = await job();
    await rateTrade(contractor, {
      order_id: order._id, trade_grade: 5,
      photos: [
        'https://cdn.test/a.jpg',
        'http://evil.test/x.png',
        'javascript:alert(1)',
        'https://res.cloudinary.com.evil.test/b.jpg',
        42, null,
      ],
    }).expect(201);

    expect((await TradeGrade.findOne({}).lean()).photos).toEqual(['https://cdn.test/a.jpg']);
  });
});

describe('GET /api/contractor/trade-grades/:tradeId/reviews', () => {
  it('omits reviews the trade pro wrote about contractors', async () => {
    const { contractor, tradePro, site, order } = await job();
    const orderB = await createWorkHoursOrder({ contractor, tradePro, site, date: '2026-04-01' });

    await rateTrade(contractor, {
      order_id: order._id, trade_grade: 5, review_text: 'Great painter',
    }).expect(201);

    await rateContractor(tradePro, {
      order_id: orderB._id, trade_grade: 1, review_text: 'This contractor paid late',
    }).expect(201);

    const res = await request(app)
      .get(`/api/contractor/trade-grades/${tradePro._id}/reviews`)
      .set(asContractor(contractor))
      .expect(200);

    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.reviews[0].review_text).toBe('Great painter');
    expect(res.body.pro.avgGrade).toBe(5);
    expect(res.body.pro.gradeCount).toBe(1);
  });

  it('shows contractor-directed reviews only on the contractor profile', async () => {
    const { contractor, tradePro, order } = await job();

    await rateContractor(tradePro, {
      order_id: order._id, trade_grade: 2, review_text: 'Paid late',
    }).expect(201);

    const res = await request(app)
      .get(`/api/trade/contractor-grades/${contractor._id}/reviews`)
      .set(asTrade(tradePro))
      .expect(200);

    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.reviews[0].review_text).toBe('Paid late');
    expect(res.body.contractor.avgGrade).toBe(2);
  });
});
