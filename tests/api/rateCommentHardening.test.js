import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import app from '../../app.js';
import Site from '../../models/Site.js';
import Contractor from '../../models/Contractor.js';
import Message, { RATE_EXPLANATION_TYPE } from '../../models/Message.js';
import { createContractor, createAdmin, asContractor } from '../helpers/factories.js';

const slot = (name, extra = {}) => ({
  name, assigned: false, budgetType: 'hours', totalHours: 8, workers_no: 1, rateComment: '', ...extra,
});

const explanations = (siteId) =>
  Message.find({ site: siteId, type: RATE_EXPLANATION_TYPE }).sort({ tradeName: 1 }).lean();

const putComment = (c, siteId, tradeName, text) =>
  request(app).put(`/api/contractor/sites/${siteId}/rate-comment`)
    .set(asContractor(c)).send({ tradeName, text });

describe('public GET /api/sites — no private slot data to anonymous callers', () => {
  it('returns only name, assigned, requiredDate and workers_no for each trade slot', async () => {
    const c = await createContractor();
    await Site.create({
      contractor: c._id, name: 'Public', type: 'commercial', address: '1 Main St',
      tradesNeeded: [slot('Painter', {
        rateComment: 'internal: we pay below market',
        maxAmount: 5000,
        assigned: true,
        tradeProId: c._id,
        requiredDate: '2026-12-01',
        workers_no: 2,
      })],
    });

    const res = await request(app).get('/api/sites').expect(200);   // no auth
    const t = res.body.sites[0].tradesNeeded[0];

    expect(t.name).toBe('Painter');
    expect(t.assigned).toBe(true);
    // Date and worker count are shown on the public Trade Area cards on purpose
    expect(t.requiredDate).toBe('2026-12-01');
    expect(t.workers_no).toBe(2);
    for (const hidden of ['rateComment', 'maxAmount', 'totalHours', 'budgetType', 'tradeProId']) {
      expect(t).not.toHaveProperty(hidden);
    }
  });

  it('still returns the site-level showcase fields', async () => {
    const c = await createContractor();
    await Site.create({ contractor: c._id, name: 'Tower', type: 'residential', address: '9 Elm', tradesNeeded: [slot('Plumber')] });

    const res = await request(app).get('/api/sites').expect(200);
    const s = res.body.sites[0];
    expect(s).toMatchObject({ name: 'Tower', type: 'residential', address: '9 Elm' });
    expect(s).not.toHaveProperty('contractor');
  });
});

describe('rate explanation mirror — concurrent edits', () => {
  it('two slots edited at the same time both end up mirrored', async () => {
    // Before the fix this failed on every run: each request rebuilt the mirror
    // from its own snapshot and its cleanup deleted the other's message.
    for (let run = 0; run < 10; run++) {
      const c = await createContractor();
      const s = await Site.create({
        contractor: c._id, name: 'T', type: 'commercial', address: 'x',
        tradesNeeded: [slot('Painter'), slot('Plumber')],
      });

      await Promise.all([
        putComment(c, s._id, 'Painter', 'paint reason').expect(200),
        putComment(c, s._id, 'Plumber', 'pipe reason').expect(200),
      ]);

      const mirrored = await explanations(s._id);
      expect(mirrored.map((m) => [m.tradeName, m.text])).toEqual([
        ['Painter', 'paint reason'],
        ['Plumber', 'pipe reason'],
      ]);
    }
  });

  it('a concurrent PATCH and PUT converge to the final site state', async () => {
    const c = await createContractor();
    const created = await request(app).post('/api/contractor/sites').set(asContractor(c))
      .send({ name: 'T', type: 'commercial', address: 'x', tradesNeeded: [slot('Painter'), slot('Plumber')] })
      .expect(201);
    const id = created.body.site._id;

    await Promise.all([
      request(app).patch(`/api/contractor/sites/${id}`).set(asContractor(c))
        .send({ tradesNeeded: [slot('Painter', { rateComment: 'from patch' }), slot('Plumber')] }),
      putComment(c, id, 'Plumber', 'from put'),
    ]);

    // Whatever order the writes landed in, the mirror must equal the site.
    const site = await Site.findById(id).lean();
    const expected = site.tradesNeeded
      .filter((t) => t.rateComment)
      .map((t) => [t.name, t.rateComment])
      .sort();
    const mirrored = (await explanations(id)).map((m) => [m.tradeName, m.text]).sort();
    expect(mirrored).toEqual(expected);
  });

  it('a sync for a site deleted mid-flight leaves no orphan explanations', async () => {
    const { syncRateExplanations } = await import('../../utils/rateExplanations.js');
    const c = await createContractor();
    const s = await Site.create({
      contractor: c._id, name: 'T', type: 'commercial', address: 'x',
      tradesNeeded: [slot('Painter', { rateComment: 'x' })],
    });
    await syncRateExplanations(s);
    expect(await explanations(s._id)).toHaveLength(1);

    await Site.deleteOne({ _id: s._id });
    await syncRateExplanations(s);   // stale doc, site gone
    expect(await explanations(s._id)).toHaveLength(0);
  });
});

// ── #3 — one slot per trade name ─────────────────────────────────────────────
const newSite = (c, tradesNeeded) =>
  request(app).post('/api/contractor/sites').set(asContractor(c))
    .send({ name: 'T', type: 'commercial', address: 'x', tradesNeeded });

describe('#3 — duplicate trade names on one project are rejected', () => {
  it('POST with two slots of the same trade → 400, nothing created', async () => {
    const c = await createContractor();
    const res = await newSite(c, [slot('Painter', { rateComment: 'a' }), slot('Painter', { rateComment: 'b' })]);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/"Painter" is listed more than once/);
    expect(await Site.countDocuments({ contractor: c._id })).toBe(0);
    expect((await Contractor.findById(c._id).lean()).sites).toHaveLength(0);
  });

  it('is case- and whitespace-insensitive, matching the rest of the app', async () => {
    const c = await createContractor();
    const res = await newSite(c, [slot('Painter'), slot('  painter ')]);
    expect(res.status).toBe(400);
  });

  it('applies to plain string arrays too', async () => {
    const c = await createContractor();
    const res = await newSite(c, ['Painter', 'Plumber', 'Painter']);
    expect(res.status).toBe(400);
  });

  it('PATCH introducing a duplicate → 400 and the site is unchanged', async () => {
    const c = await createContractor();
    const created = await newSite(c, [slot('Painter'), slot('Plumber')]).expect(201);
    const id = created.body.site._id;

    const res = await request(app).patch(`/api/contractor/sites/${id}`).set(asContractor(c))
      .send({ tradesNeeded: [slot('Painter'), slot('PAINTER')] });

    expect(res.status).toBe(400);
    expect((await Site.findById(id).lean()).tradesNeeded.map((t) => t.name)).toEqual(['Painter', 'Plumber']);
  });

  it('the admin PATCH is blocked too (schema-level backstop)', async () => {
    const admin = await createAdmin();
    const owner = await createContractor();
    const s = await Site.create({ contractor: owner._id, name: 'T', type: 'commercial', address: 'x', tradesNeeded: [slot('Painter')] });

    const res = await request(app).patch(`/api/admin/sites/${s._id}`).set(asContractor(admin))
      .send({ tradesNeeded: [slot('Painter'), slot('Painter')] });

    expect(res.status).toBe(400);
    expect((await Site.findById(s._id).lean()).tradesNeeded).toHaveLength(1);
  });

  it('distinct trades are still accepted', async () => {
    const c = await createContractor();
    await newSite(c, [slot('Painter', { rateComment: 'a' }), slot('Plumber', { rateComment: 'b' })]).expect(201);
  });

  it('malformed tradesNeeded JSON is a clean 400, not a 500', async () => {
    const c = await createContractor();
    const res = await newSite(c, 'not json');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/JSON array/);
  });

  it('an existing project that already has duplicates keeps working for comment edits', async () => {
    // Legacy data written before the rule: bypass validation via the raw driver.
    const c = await createContractor();
    const { insertedId } = await Site.collection.insertOne({
      contractor: c._id, name: 'Legacy', type: 'commercial', address: 'x', status: 'active',
      tradesNeeded: [slot('Painter'), slot('Painter')], location: { type: 'Point', coordinates: [0, 0] },
    });

    await putComment(c, insertedId, 'Painter', 'still editable').expect(200);
  });
});

// ── #4 — a mirror failure never fails a save that succeeded ──────────────────
describe('#4 — the explanation mirror is non-fatal', () => {
  it('PUT returns 200 when the mirror update fails, and the next save repairs it', async () => {
    const c = await createContractor();
    const s = await Site.create({ contractor: c._id, name: 'T', type: 'commercial', address: 'x', tradesNeeded: [slot('Painter')] });

    const spy = vi.spyOn(Message, 'findOneAndUpdate').mockRejectedValueOnce(new Error('db blip'));
    const res = await putComment(c, s._id, 'Painter', 'saved');
    spy.mockRestore();

    expect(res.status).toBe(200);                                              // was 500
    expect((await Site.findById(s._id).lean()).tradesNeeded[0].rateComment).toBe('saved');
    expect(await explanations(s._id)).toHaveLength(0);                         // copy lagging…

    await putComment(c, s._id, 'Painter', 'saved').expect(200);                // …next save heals it
    expect((await explanations(s._id)).map((m) => m.text)).toEqual(['saved']);
  });

  it('create returns 201 (one project, no duplicate) when the mirror fails', async () => {
    const c = await createContractor();
    const spy = vi.spyOn(Message, 'findOneAndUpdate').mockRejectedValueOnce(new Error('db blip'));
    const res = await newSite(c, [slot('Painter', { rateComment: 'x' })]);
    spy.mockRestore();

    expect(res.status).toBe(201);
    expect(await Site.countDocuments({ contractor: c._id })).toBe(1);
  });

  it('deleting a project succeeds even if explanation cleanup fails', async () => {
    const c = await createContractor();
    const created = await newSite(c, [slot('Painter', { rateComment: 'x' })]).expect(201);
    const id = created.body.site._id;

    const spy = vi.spyOn(Message, 'deleteMany').mockRejectedValueOnce(new Error('db blip'));
    const res = await request(app).delete(`/api/contractor/sites/${id}`).set(asContractor(c));
    spy.mockRestore();

    expect(res.status).toBe(200);
    expect(await Site.findById(id)).toBeNull();
  });
});

// ── #5 — case-insensitive, literal trade-name matching ───────────────────────
describe('#5 — the comment endpoint matches trade names like the rest of the app', () => {
  it('PUT with a differently-cased name updates the slot', async () => {
    const c = await createContractor();
    const s = await Site.create({ contractor: c._id, name: 'T', type: 'commercial', address: 'x', tradesNeeded: [slot('Painter')] });

    await putComment(c, s._id, 'painter', 'lowercase works').expect(200);
    expect((await Site.findById(s._id).lean()).tradesNeeded[0].rateComment).toBe('lowercase works');
  });

  it('DELETE with a differently-cased name clears the comment', async () => {
    const c = await createContractor();
    const s = await Site.create({ contractor: c._id, name: 'T', type: 'commercial', address: 'x',
      tradesNeeded: [slot('Painter', { rateComment: 'x' })] });

    await request(app).delete(`/api/contractor/sites/${s._id}/rate-comment`)
      .query({ tradeName: 'PAINTER' }).set(asContractor(c)).expect(200);
    expect((await Site.findById(s._id).lean()).tradesNeeded[0].rateComment).toBe('');
  });

  it('regex characters in the name are matched literally, not as a pattern', async () => {
    const c = await createContractor();
    const s = await Site.create({ contractor: c._id, name: 'T', type: 'commercial', address: 'x', tradesNeeded: [slot('Painter')] });

    for (const pattern of ['.*', 'P.*', '^Painter', '(Painter)', 'Paint[e]r']) {
      await putComment(c, s._id, pattern, 'should not land').expect(404);
    }
    expect((await Site.findById(s._id).lean()).tradesNeeded[0].rateComment).toBe('');
  });

  it("still refuses another contractor's project", async () => {
    const owner = await createContractor();
    const other = await createContractor();
    const s = await Site.create({ contractor: owner._id, name: 'T', type: 'commercial', address: 'x', tradesNeeded: [slot('Painter')] });

    await putComment(other, s._id, 'painter', 'nope').expect(404);
  });
});
