import { Router } from 'express';
import Site         from '../models/Site.js';
import TradePro     from '../models/TradePro.js';
import Contractor   from '../models/Contractor.js';
import WorkHoursOrder from '../models/WorkHoursOrder.js';
import Receipt       from '../models/Receipt.js';
import { protect, adminOnly } from '../middleware/auth.js';
import { geocodeAddress } from '../utils/geocode.js';

import authRoutes       from './auth.js';
import contractorRoutes from './contractor.js';
import tradeRoutes      from './trade.js';
import chatRoutes       from './chat.js';
import stripeRoutes     from './stripe.js';

const router = Router();

router.use('/auth',       authRoutes);
router.use('/contractor', contractorRoutes);
router.use('/trade',      tradeRoutes);
router.use('/chat',       chatRoutes);
router.use('/stripe',     stripeRoutes);

router.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Public — US address autocomplete proxy (Photon/OpenStreetMap)
// Avoids browser CSP issues by fetching server-side.
router.get('/address/autocomplete', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ features: [] });
  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&countrycode=us&limit=6&lang=en`;
    const response = await fetch(url);
    const data     = await response.json();
    res.json(data);
  } catch {
    res.json({ features: [] });
  }
});

// Public — returns all distinct trade types (professionality values) from trade_pros
router.get('/trade-types', async (_req, res, next) => {
  try {
    const types = await TradePro.distinct('professionality');
    res.json({ types: types.filter(Boolean).sort() });
  } catch (err) {
    next(err);
  }
});

// Public — returns all trade professionals for the contractor showcase
router.get('/tradepros', async (_req, res, next) => {
  try {
    const tradePros = await TradePro.find({})
      .select('fullName professionality photo hourlyRate address')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ tradePros });
  } catch (err) {
    next(err);
  }
});

// Public — returns all projects for the trade professional showcase
router.get('/sites', async (_req, res, next) => {
  try {
    const sites = await Site.find({})
      .select('name address type photo tradesNeeded')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ sites });
  } catch (err) {
    next(err);
  }
});

// Admin dashboard stats — admin contractors only
router.get('/admin/stats', protect, adminOnly, async (_req, res, next) => {
  try {
    const [
      tradeCount,
      contractorCount,
      siteCount,
      orderAgg,
      tradeDistRaw,
      ordersByMonthRaw,
    ] = await Promise.all([
      TradePro.countDocuments(),
      Contractor.countDocuments(),
      Site.countDocuments(),
      WorkHoursOrder.aggregate([{ $group: { _id: null, total: { $sum: '$order_sum' } } }]),
      TradePro.aggregate([
        { $group: { _id: '$professionality', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      WorkHoursOrder.aggregate([
        { $match: { status: 'approved' } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
            total: { $sum: '$order_sum' },
          },
        },
        { $sort: { _id: 1 } },
        { $limit: 12 },
      ]),
    ]);

    res.json({
      stats: {
        tradeUsers:      tradeCount,
        contractorUsers: contractorCount,
        totalSites:      siteCount,
        totalOrderSum:   orderAgg[0]?.total ?? 0,
      },
      tradeDist:     tradeDistRaw.map(r => ({ name: r._id || 'Other', value: r.count })),
      ordersByMonth: ordersByMonthRaw.map(r => ({ month: r._id, total: r.total })),
    });
  } catch (err) {
    next(err);
  }
});

// Admin — list all contractors
router.get('/admin/contractors', protect, adminOnly, async (_req, res, next) => {
  try {
    const contractors = await Contractor.find({})
      .select('companyName address email expertise user_type')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ contractors });
  } catch (err) {
    next(err);
  }
});

// Admin — update a contractor
router.patch('/admin/contractors/:id', protect, adminOnly, async (req, res, next) => {
  try {
    const { companyName, address, email, expertise, user_type } = req.body;
    const update = {};
    if (companyName !== undefined) update.companyName = companyName;
    if (address     !== undefined) update.address     = address;
    if (email       !== undefined) update.email       = email;
    if (expertise   !== undefined) update.expertise   = expertise;
    if (user_type   !== undefined) update.user_type   = user_type;

    const updated = await Contractor.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true })
      .select('companyName address email expertise user_type')
      .lean();
    if (!updated) return res.status(404).json({ message: 'Contractor not found' });
    res.json({ contractor: updated });
  } catch (err) {
    next(err);
  }
});

// Admin — delete a contractor
router.delete('/admin/contractors/:id', protect, adminOnly, async (req, res, next) => {
  try {
    const deleted = await Contractor.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Contractor not found' });
    res.json({ ok: true, _id: req.params.id });
  } catch (err) {
    next(err);
  }
});

// Admin — list all trade professionals
router.get('/admin/tradepros', protect, adminOnly, async (_req, res, next) => {
  try {
    const tradePros = await TradePro.find({})
      .select('fullName photo professionality email hourlyRate avgGrade gradeCount')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ tradePros });
  } catch (err) {
    next(err);
  }
});

// Admin — update a trade professional
router.patch('/admin/tradepros/:id', protect, adminOnly, async (req, res, next) => {
  try {
    const { fullName, professionality, email, hourlyRate } = req.body;
    const update = {};
    if (fullName        !== undefined) update.fullName        = fullName;
    if (professionality !== undefined) update.professionality = professionality;
    if (email           !== undefined) update.email           = email;
    if (hourlyRate      !== undefined) update.hourlyRate      = hourlyRate === '' ? null : Number(hourlyRate);

    const updated = await TradePro.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true })
      .select('fullName photo professionality email hourlyRate avgGrade gradeCount')
      .lean();
    if (!updated) return res.status(404).json({ message: 'Trade professional not found' });
    res.json({ tradePro: updated });
  } catch (err) {
    next(err);
  }
});

// Admin — delete a trade professional
router.delete('/admin/tradepros/:id', protect, adminOnly, async (req, res, next) => {
  try {
    const deleted = await TradePro.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Trade professional not found' });
    res.json({ ok: true, _id: req.params.id });
  } catch (err) {
    next(err);
  }
});

// Admin — list all sites
router.get('/admin/sites', protect, adminOnly, async (_req, res, next) => {
  try {
    const sites = await Site.find({})
      .select('name type address tradesNeeded photo status')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ sites });
  } catch (err) {
    next(err);
  }
});

// Admin — update a site
router.patch('/admin/sites/:id', protect, adminOnly, async (req, res, next) => {
  try {
    const { name, type, address, status, tradesNeeded } = req.body;
    const update = {};
    if (name         !== undefined) update.name         = name;
    if (type         !== undefined) update.type         = type;
    if (address      !== undefined) update.address      = address;
    if (status       !== undefined) update.status       = status;
    if (tradesNeeded !== undefined) update.tradesNeeded = tradesNeeded;

    // Address changed — re-geocode so location.coordinates doesn't go stale
    if (address !== undefined) {
      const coords = await geocodeAddress(address);
      update.location = {
        type: 'Point',
        coordinates: coords ? [parseFloat(coords.lng), parseFloat(coords.lat)] : [0.0, 0.0],
      };
    }

    const updated = await Site.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true })
      .select('name type address tradesNeeded photo status')
      .lean();
    if (!updated) return res.status(404).json({ message: 'Site not found' });
    res.json({ site: updated });
  } catch (err) {
    next(err);
  }
});

// Admin — delete a site
router.delete('/admin/sites/:id', protect, adminOnly, async (req, res, next) => {
  try {
    const deleted = await Site.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Site not found' });
    res.json({ ok: true, _id: req.params.id });
  } catch (err) {
    next(err);
  }
});

// Admin — list all work-hours orders
router.get('/admin/orders', protect, adminOnly, async (_req, res, next) => {
  try {
    const orders = await WorkHoursOrder.find({})
      .populate('contractor_id', 'companyName')
      .populate('trade_id',      'fullName professionality')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      orders: orders.map(o => ({
        _id:             o._id,
        contractor_name: o.contractor_id?.companyName ?? '—',
        trade_name:      o.trade_id?.fullName ?? '—',
        professionality: o.trade_id?.professionality ?? '—',
        date:            o.date,
        actual_hours:    o.actual_hours,
        hourly_rate:     o.hourly_rate,
        workers_no:      o.workers_no,
        order_sum:       o.order_sum,
        status:          o.status,
        paymentStatus:   o.paymentStatus,
        payment_sum:     o.payment_sum,
        fee_sum:         o.fee_sum,
        receiptSent:     o.receiptSent,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Admin — delete an order
router.delete('/admin/orders/:id', protect, adminOnly, async (req, res, next) => {
  try {
    const deleted = await WorkHoursOrder.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Order not found' });
    res.json({ ok: true, _id: req.params.id });
  } catch (err) {
    next(err);
  }
});

// Admin — fetch the contractor or trade receipt tied to an order
router.get('/admin/orders/:id/receipt', protect, adminOnly, async (req, res, next) => {
  try {
    const { type } = req.query; // 'contractor' | 'trade'
    if (!['contractor', 'trade'].includes(type)) {
      return res.status(400).json({ message: 'type must be "contractor" or "trade"' });
    }

    const receipt = await Receipt.findOne({ order_id: req.params.id, receipt_type: type }).lean();
    if (!receipt) return res.status(404).json({ message: 'Receipt not found' });

    res.json({ receipt });
  } catch (err) {
    next(err);
  }
});

export default router;
