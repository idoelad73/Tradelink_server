import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../app.js';
import Site from '../../models/Site.js';
import Message, { RATE_EXPLANATION_TYPE } from '../../models/Message.js';
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

describe('rateComment — total_hours_explanations messages', () => {
  const explanations = (siteId) =>
    Message.find({ site: siteId, type: RATE_EXPLANATION_TYPE }).lean();

  it('mirrors the comment into messages when a site is created, and drops it when cleared', async () => {
    const contractor = await createContractor();
    const res = await request(app)
      .post('/api/contractor/sites')
      .set(asContractor(contractor))
      .field('name',    'Mirror Tower')
      .field('type',    'commercial')
      .field('address', '1 Main St, New York, NY')
      .field('tradesNeeded', JSON.stringify([trade({ rateComment: 'Two coats.' })]));
    expect(res.status).toBe(201);

    let msgs = await explanations(res.body.site._id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ tradeName: 'Painter', text: 'Two coats.', senderType: 'contractor' });

    await request(app)
      .patch(`/api/contractor/sites/${res.body.site._id}`)
      .set(asContractor(contractor))
      .send({ tradesNeeded: [trade({ rateComment: '' })] });
    msgs = await explanations(res.body.site._id);
    expect(msgs).toHaveLength(0);
  });

  it('PUT /rate-comment edits it any time (even on an assigned slot) and DELETE removes it', async () => {
    const contractor = await createContractor();
    const site = await createSite(contractor, { tradesNeeded: [trade({ assigned: true })] });

    const put = await request(app)
      .put(`/api/contractor/sites/${site._id}/rate-comment`)
      .set(asContractor(contractor))
      .send({ tradeName: 'Painter', text: '  Includes scaffolding.  ' });
    expect(put.status).toBe(200);
    expect(put.body.site.tradesNeeded[0].rateComment).toBe('Includes scaffolding.');

    await request(app)
      .put(`/api/contractor/sites/${site._id}/rate-comment`)
      .set(asContractor(contractor))
      .send({ tradeName: 'Painter', text: 'Updated text.' });
    let msgs = await explanations(site._id);
    expect(msgs).toHaveLength(1);                 // upsert, not a second message
    expect(msgs[0].text).toBe('Updated text.');

    const del = await request(app)
      .delete(`/api/contractor/sites/${site._id}/rate-comment?tradeName=Painter`)
      .set(asContractor(contractor));
    expect(del.status).toBe(200);
    expect((await Site.findById(site._id).lean()).tradesNeeded[0].rateComment).toBe('');
    expect(await explanations(site._id)).toHaveLength(0);
  });

  it("refuses another contractor's project", async () => {
    const owner = await createContractor();
    const other = await createContractor();
    const site  = await createSite(owner, { tradesNeeded: [trade()] });

    const res = await request(app)
      .put(`/api/contractor/sites/${site._id}/rate-comment`)
      .set(asContractor(other))
      .send({ tradeName: 'Painter', text: 'Hijack' });
    expect(res.status).toBe(404);
    expect(await explanations(site._id)).toHaveLength(0);
  });

  it('keeps explanations out of the project messages list', async () => {
    const contractor = await createContractor();
    const site = await createSite(contractor, { tradesNeeded: [trade()] });
    await request(app)
      .put(`/api/contractor/sites/${site._id}/rate-comment`)
      .set(asContractor(contractor))
      .send({ tradeName: 'Painter', text: 'Note' });

    const res = await request(app)
      .get(`/api/contractor/sites/${site._id}/messages`)
      .set(asContractor(contractor));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(RATE_EXPLANATION_TYPE);
  });
});
