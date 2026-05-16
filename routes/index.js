import { Router } from 'express';

import authRoutes from './auth.js';
// import userRoutes from './user.routes.js';
// import jobRoutes from './job.routes.js';
// import tradeRoutes from './trade.routes.js';
// import stripeRoutes from './stripe.routes.js';

const router = Router();

router.use('/auth',   authRoutes);
// router.use('/users',  userRoutes);
// router.use('/jobs',   jobRoutes);
// router.use('/trades', tradeRoutes);
// router.use('/stripe', stripeRoutes);

router.get('/health', (_req, res) => res.json({ status: 'ok' }));

export default router;
