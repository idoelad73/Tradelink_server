/**
 * backfillTotalWorkingHrs.js
 *
 * One-time migration: sets totalWorkingHrs = totalHours × workers_no
 * for every existing tradesNeeded entry where budgetType === 'hours'
 * and both totalHours and workers_no are present.
 *
 * Run:
 *   node server/scripts/backfillTotalWorkingHrs.js
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌  MONGO_URI not set'); process.exit(1); }

await mongoose.connect(MONGO_URI);
console.log('✅  Connected');

const db   = mongoose.connection.db;
const coll = db.collection('sites');

// Fetch all sites that have tradesNeeded with hours budget
const sites = await coll.find({
  'tradesNeeded': { $elemMatch: { budgetType: 'hours', totalHours: { $ne: null }, workers_no: { $ne: null } } },
}).toArray();

console.log(`📊  Sites to process: ${sites.length}`);

let updated = 0;
for (const site of sites) {
  const newTrades = site.tradesNeeded.map((tr) => {
    if (tr.budgetType === 'hours' && tr.totalHours != null && tr.workers_no != null) {
      return { ...tr, totalWorkingHrs: tr.totalHours * tr.workers_no };
    }
    return tr;
  });

  await coll.updateOne(
    { _id: site._id },
    { $set: { tradesNeeded: newTrades } }
  );
  updated++;
  console.log(`  ✓ ${site.name}`);
}

console.log(`\n✅  Backfilled ${updated} site(s)`);
await mongoose.disconnect();
console.log('🏁  Done\n');
