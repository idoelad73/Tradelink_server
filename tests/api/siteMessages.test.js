import { describe, it, expect } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../app.js';
import Message from '../../models/Message.js';
import {
  createContractor, createTradePro, createSite,
  asContractor,
} from '../helpers/factories.js';

const msg = (over = {}) => ({
  tradePro:      over.tradePro,
  contractor:    over.contractor,
  site:          over.site,
  type:          'application',
  status:        'pending',
  senderType:    'trade',
  tradeName:     'Painter',
  requestedDate: '2026-12-01',
  ...over,
});

describe('GET /api/contractor/sites/:siteId/messages', () => {
  it('returns every message for the project, newest first', async () => {
    const contractor = await createContractor();
    const tradePro   = await createTradePro();
    const site       = await createSite(contractor);

    await Message.create(msg({ contractor: contractor._id, tradePro: tradePro._id, site: site._id, type: 'application',  status: 'pending'  }));
    await Message.create(msg({ contractor: contractor._id, tradePro: tradePro._id, site: site._id, type: 'worker_offer', status: 'approved' }));
    await Message.create(msg({ contractor: contractor._id, tradePro: tradePro._id, site: site._id, type: 'reschedule',   status: 'approved' }));

    const res = await request(app)
      .get(`/api/contractor/sites/${site._id}/messages`)
      .set(asContractor(contractor));

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(3);
    expect(res.body.site.name).toBe(site.name);
    // Both pending and already-actioned items are present — this is the audit trail.
    expect(res.body.messages.map((m) => m.type).sort())
      .toEqual(['application', 'reschedule', 'worker_offer']);
  });

  it('decodes a payment message snapshot instead of leaking raw JSON', async () => {
    const contractor = await createContractor();
    const tradePro   = await createTradePro();
    const site       = await createSite(contractor);

    await Message.create(msg({
      contractor: contractor._id, tradePro: tradePro._id, site: site._id,
      type: 'payment', status: 'pending', senderType: 'trade',
      text: JSON.stringify({ actual_hours: 7, hourly_rate: 50, workers_no: 2, order_sum: 700 }),
    }));

    const res = await request(app)
      .get(`/api/contractor/sites/${site._id}/messages`)
      .set(asContractor(contractor));

    const payment = res.body.messages.find((m) => m.type === 'payment');
    expect(payment.snapshot).toMatchObject({ actual_hours: 7, order_sum: 700 });
    expect(payment.text).toBeNull(); // raw JSON must not reach the UI as prose
  });

  it("refuses another contractor's project", async () => {
    const owner    = await createContractor();
    const stranger = await createContractor();
    const site     = await createSite(owner);

    const res = await request(app)
      .get(`/api/contractor/sites/${site._id}/messages`)
      .set(asContractor(stranger));

    expect(res.status).toBe(404);
    expect(res.body.messages).toBeUndefined();
  });

  it('404s on an unknown site id rather than returning an empty list', async () => {
    const contractor = await createContractor();
    const res = await request(app)
      .get(`/api/contractor/sites/${new mongoose.Types.ObjectId()}/messages`)
      .set(asContractor(contractor));

    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const contractor = await createContractor();
    const site       = await createSite(contractor);
    const res = await request(app).get(`/api/contractor/sites/${site._id}/messages`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/contractor/applications — approved items are visible', () => {
  it('returns approved worker offers and reschedules alongside pending ones', async () => {
    const contractor = await createContractor();
    const tradePro   = await createTradePro();
    const site       = await createSite(contractor);

    await Message.create(msg({ contractor: contractor._id, tradePro: tradePro._id, site: site._id, type: 'worker_offer', status: 'pending'  }));
    await Message.create(msg({ contractor: contractor._id, tradePro: tradePro._id, site: site._id, type: 'worker_offer', status: 'approved' }));
    await Message.create(msg({ contractor: contractor._id, tradePro: tradePro._id, site: site._id, type: 'reschedule',   status: 'pending'  }));
    await Message.create(msg({ contractor: contractor._id, tradePro: tradePro._id, site: site._id, type: 'reschedule',   status: 'approved' }));

    const res = await request(app)
      .get('/api/contractor/applications')
      .set(asContractor(contractor));

    expect(res.status).toBe(200);
    expect(res.body.workerOffers.map((o) => o.status).sort()).toEqual(['approved', 'pending']);
    expect(res.body.reschedules.map((r) => r.status).sort()).toEqual(['approved', 'pending']);
  });

  it('still excludes rejected items, so the list is not a dumping ground', async () => {
    const contractor = await createContractor();
    const tradePro   = await createTradePro();
    const site       = await createSite(contractor);

    await Message.create(msg({ contractor: contractor._id, tradePro: tradePro._id, site: site._id, type: 'worker_offer', status: 'rejected' }));

    const res = await request(app)
      .get('/api/contractor/applications')
      .set(asContractor(contractor));

    expect(res.body.workerOffers).toHaveLength(0);
  });
});
