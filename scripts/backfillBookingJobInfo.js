/**
 * backfillBookingJobInfo.js
 *
 * One-time migration: adds totalHours and workers_no to existing tradepro bookings
 * that were created before these fields were added to the model.
 *
 * Run:
 *   node server/scripts/backfillBookingJobInfo.js
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

const db        = mongoose.connection.db;
const tradepros = db.collection('tradepros');
const sites     = db.collection('sites');
const messages  = db.collection('messages');

const pros = await tradepros.find({ 'bookings.0': { $exists: true } }).toArray();
console.log(`📊  Trade pros with bookings: ${pros.length}`);

let updated = 0;
for (const pro of pros) {
  let changed = false;
  const newBookings = await Promise.all(pro.bookings.map(async (bk) => {
    // Already backfilled
    if (bk.totalHours !== undefined || bk.workers_no !== undefined) return bk;

    // Look up site tradesNeeded for this trade pro's professionality
    const site = bk.siteId
      ? await sites.findOne({ _id: bk.siteId }, { projection: { tradesNeeded: 1 } })
      : null;

    const slot = site?.tradesNeeded?.find(
      (t) => t.name?.toLowerCase() === pro.professionality?.toLowerCase()
    );

    // Look up the original availability message to get workersOffered
    const msg = bk.siteId
      ? await messages.findOne({
          tradePro:  pro._id,
          site:      bk.siteId,
          type:      'availability',
        }, { projection: { workersOffered: 1 } })
      : null;

    changed = true;
    return {
      ...bk,
      totalHours: slot?.totalHours ?? null,
      workers_no: msg?.workersOffered ?? 1,
    };
  }));

  if (changed) {
    await tradepros.updateOne({ _id: pro._id }, { $set: { bookings: newBookings } });
    console.log(`  ✓ ${pro.fullName} — ${pro.bookings.length} booking(s) updated`);
    updated++;
  }
}

console.log(`\n✅  Backfilled ${updated} trade pro(s)`);
await mongoose.disconnect();
console.log('🏁  Done\n');
