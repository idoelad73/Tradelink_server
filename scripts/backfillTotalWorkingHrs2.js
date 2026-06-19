/**
 * backfillTotalWorkingHrs2.js
 *
 * One-time fix: recomputes totalWorkingHrs for all tradesNeeded entries
 * where budgetType === 'hours' and totalHours + workers_no exist but
 * totalWorkingHrs is null (was stripped by the old normalizeTrades bug).
 *
 * Run:
 *   node server/scripts/backfillTotalWorkingHrs2.js
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
console.log('✅  Connected\n');

const sites = mongoose.connection.db.collection('sites');

const all = await sites.find({
  'tradesNeeded': { $elemMatch: {
    budgetType: 'hours',
    totalHours: { $gt: 0 },
    workers_no: { $gt: 0 },
    totalWorkingHrs: null,
  }}
}).toArray();

console.log(`📊  Sites with missing totalWorkingHrs: ${all.length}`);

let fixed = 0;
for (const site of all) {
  let changed = false;
  const updatedTrades = site.tradesNeeded.map((t) => {
    if (t.budgetType === 'hours' && t.totalHours > 0 && t.workers_no > 0 && t.totalWorkingHrs == null) {
      changed = true;
      return { ...t, totalWorkingHrs: t.totalHours * t.workers_no };
    }
    return t;
  });

  if (changed) {
    await sites.updateOne({ _id: site._id }, { $set: { tradesNeeded: updatedTrades } });
    console.log(`  ✓ ${site.name}`);
    fixed++;
  }
}

console.log(`\n✅  Fixed ${fixed} site(s)`);
await mongoose.disconnect();
console.log('🏁  Done\n');
