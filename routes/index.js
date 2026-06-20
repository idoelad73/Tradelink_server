import { Router } from 'express';
import Site from '../models/Site.js';
import TradePro from '../models/TradePro.js';

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

export default router;
