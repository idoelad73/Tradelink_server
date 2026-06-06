import { Router } from 'express';
import Site from '../models/Site.js';
import TradePro from '../models/TradePro.js';

import authRoutes       from './auth.js';
import contractorRoutes from './contractor.js';
import tradeRoutes      from './trade.js';
import chatRoutes       from './chat.js';
// import userRoutes from './user.routes.js';
// import jobRoutes from './job.routes.js';
// import tradeRoutes from './trade.routes.js';
// import stripeRoutes from './stripe.routes.js';

const router = Router();

router.use('/auth',       authRoutes);
router.use('/contractor', contractorRoutes);
router.use('/trade',      tradeRoutes);
router.use('/chat',       chatRoutes);
// router.use('/users',  userRoutes);
// router.use('/jobs',   jobRoutes);
// router.use('/trades', tradeRoutes);
// router.use('/stripe', stripeRoutes);

router.get('/health', (_req, res) => res.json({ status: 'ok' }));

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
