/**
 * cleanAll.js
 * Clears busyDays + bookings from all TradePros, deletes all Messages, and
 * resets all Site tradesNeeded (assigned → false, tradeProId → null, requiredDate → null).
 *
 * Run:  node server/scripts/cleanAll.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) { console.error('❌  No MONGO_URI in .env'); process.exit(1); }

await mongoose.connect(MONGO_URI);
console.log('✅  Connected to MongoDB\n');

/* ── 1. TradePros — wipe busyDays & bookings ─────────────────────────────── */
const tpResult = await mongoose.connection.collection('tradepros').updateMany(
  {},
  { $set: { busyDays: [], bookings: [] } }
);
console.log(`TradePros updated : ${tpResult.modifiedCount} docs  (busyDays=[], bookings=[])`);

/* ── 2. Messages — delete all ────────────────────────────────────────────── */
const msgResult = await mongoose.connection.collection('messages').deleteMany({});
console.log(`Messages deleted  : ${msgResult.deletedCount} docs`);

/* ── 3. Sites — reset every tradesNeeded entry ───────────────────────────── */
const sitesCol = mongoose.connection.collection('sites');
const sites    = await sitesCol.find({}).toArray();
let siteCount  = 0;

for (const site of sites) {
  if (!Array.isArray(site.tradesNeeded) || site.tradesNeeded.length === 0) continue;

  const reset = site.tradesNeeded.map(t => ({
    ...t,
    assigned:     false,
    tradeProId:   null,
    requiredDate: null,
  }));

  await sitesCol.updateOne(
    { _id: site._id },
    { $set: { tradesNeeded: reset } }
  );
  siteCount++;
}
console.log(`Sites reset       : ${siteCount} docs  (assigned=false, tradeProId=null, requiredDate=null)`);

/* ── done ────────────────────────────────────────────────────────────────── */
console.log('\n🎉  Cleanup complete!');
await mongoose.disconnect();
