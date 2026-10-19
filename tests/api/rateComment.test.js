import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../app.js';
import Site from '../../models/Site.js';
import {
  createContractor, createTradePro, createSite,
  asContractor, asTrade,
} from '../helpers/factories.js';

/**
 * rateComment lives on Site.tradesNeeded[] and has to survive normalizeTrades(),
 * which is an exhaustive whitelist — a field missing from it is silently dropped
 * on save. These tests pin that round-trip plus the read path the trade pro uses.
 */

const trade = (over = {}) => ({
  name: 'Painter', assigned: false,
  budgetType: 'amount', maxAmount: 500, workers_no: 2,
  requiredDate: '2026-12-01',
  ...over,
});

describe('rateComment — contractor write path', () => {
  it('persists rateComment through POST /api/contractor/sites', async () => {
    const contractor = await createContractor();

    const res = await request(app)
      .post('/api/contractor/sites')
      .set(asContractor(contractor))
      .field('name',    'Rate Comment Tower')
      .field('type',    'commercial')
      .field('address', '5 Main St, New York, NY')
      .field('tradesNeeded', JSON.stringify([
        trade({ rateComment: 'Priced for 2 coats incl. materials; scaffold is on us.' }),
      ]));

    expect(res.status).toBe(201);

    const saved = await Site.findOne({ name: 'Rate Comment Tower' }).lean();
    expect(saved.tradesNeeded[0].rateComment)
      .toBe('Priced for 2 coats incl. materials; scaffold is on us.');
  });

  it('persists rateComment through PATCH /api/contractor/sites/:id', async () => {
    const contractor = await createContractor();
    const site       = await createSite(contractor, { tradesNeeded: [trade()] });

    const res = await request(app)
      .patch(`/api/contractor/sites/${site._id}`)
      .set(asContractor(contractor))
      .send({ tradesNeeded: [trade({ rateComment: 'Rate assumes weekend access.' })] });

    expect(res.status).toBe(200);

    const saved = await Site.findById(site._id).lean();
    expect(saved.tradesNeeded[0].rateComment).toBe('Rate assumes weekend access.');
  });

  it('keeps the comment when no budget was set', async () => {
    const contractor = await createContractor();
    const site       = await createSite(contractor, { tradesNeeded: [trade()] });

    await request(app)
      .patch(`/api/contractor/sites/${site._id}`)
      .set(asContractor(contractor))
      .send({ tradesNeeded: [{
        name: 'Painter', assigned: false,
        budgetType: null, maxAmount: null, totalHours: null, workers_no: null,
        rateComment: 'Priced after a site visit.',
      }] });

    const saved = await Site.findById(site._id).lean();
    expect(saved.tradesNeeded[0].budgetType).toBeNull();
    expect(saved.tradesNeeded[0].rateComment).toBe('Priced after a site visit.');
  });

  it('defaults to an empty string when omitted, and does not clobber siblings', async () => {
    const contractor = await createContractor();
    const site       = await createSite(contractor, { tradesNeeded: [trade()] });

    await request(app)
      .patch(`/api/contractor/sites/${site._id}`)
      .set(asContractor(contractor))
      .send({ tradesNeeded: [trade()] }); // no rateComment key at all

    const saved = await Site.findById(site._id).lean();
    expect(saved.tradesNeeded[0].rateComment).toBe('');
    // The whitelist must still carry everything else through.
    expect(saved.tradesNeeded[0].maxAmount).toBe(500);
    expect(saved.tradesNeeded[0].workers_no).toBe(2);
    expect(saved.tradesNeeded[0].requiredDate).toBe('2026-12-01');
  });

  it('accepts a plain string trade array without crashing', async () => {
    const contractor = await createContractor();
    const site       = await createSite(contractor, { tradesNeeded: [trade()] });

    const res = await request(app)
      .patch(`/api/contractor/sites/${site._id}`)
      .set(asContractor(contractor))
      .send({ tradesNeeded: ['Plumber'] });

    expect(res.status).toBe(200);
    const saved = await Site.findById(site._id).lean();
    expect(saved.tradesNeeded[0].name).toBe('Plumber');
    expect(saved.tradesNeeded[0].rateComment).toBe('');
  });
});

describe('rateComment — trade read path', () => {
  it('reaches the trade pro on a job card via GET /api/trade/find-jobs', async () => {
    const contractor = await createContractor();
    const tradePro   = await createTradePro({ professionality: 'Painter' });

    // findJobs is a $geoNear pipeline: both ends need real coordinates.
    await createSite(contractor, {
      name:     'Nearby Job',
      location: { type: 'Point', coordinates: [-73.9857, 40.7484] },
      tradesNeeded: [trade({ rateComment: 'Budget covers prep + 2 coats.' })],
    });
    tradePro.location = { type: 'Point', coordinates: [-73.9860, 40.7480] };
    await tradePro.save();

    const res = await request(app)
      .get('/api/trade/find-jobs?distance=25&unit=mi')
      .set(asTrade(tradePro));

    expect(res.status).toBe(200);
    const job = res.body.results.find((r) => r.name === 'Nearby Job');
    expect(job).toBeDefined();
    expect(job.tradeEntry.rateComment).toBe('Budget covers prep + 2 coats.');
  });
});
