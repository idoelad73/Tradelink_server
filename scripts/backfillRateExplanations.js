/**
 * One-off backfill — run from server/ directory:
 *   node --env-file=.env scripts/backfillRateExplanations.js           (dry run)
 *   node --env-file=.env scripts/backfillRateExplanations.js --apply
 *
 * Creates a `total_hours_explanations` message for every existing
 * Site.tradesNeeded[].rateComment. New and edited comments are mirrored
 * automatically (utils/rateExplanations.js); this only covers comments written
 * before that existed. Safe to re-run — it upserts.
 */

import mongoose from 'mongoose';
import Site from '../models/Site.js';
import { syncRateExplanations } from '../utils/rateExplanations.js';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('MONGO_URI not set'); process.exit(1); }
const APPLY = process.argv.includes('--apply');

await mongoose.connect(MONGO_URI);
try {
  const sites = await Site.find({ 'tradesNeeded.rateComment': { $nin: [null, ''] } });
  let comments = 0;
  for (const site of sites) {
    const withComment = site.tradesNeeded.filter((t) => t.rateComment?.trim());
    comments += withComment.length;
    console.log(`${site.name}: ${withComment.map((t) => t.name).join(', ')}`);
    if (APPLY) await syncRateExplanations(site);
  }
  console.log(`\n${comments} comment(s) on ${sites.length} site(s) — ${APPLY ? 'mirrored to messages' : 'dry run, re-run with --apply'}`);
} finally {
  await mongoose.disconnect();
}
