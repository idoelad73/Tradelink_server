/**
 * cleanBookings.js
 * Clears all booking-related data from the tradelink database.
 *
 * What it resets:
 *   - tradepros.bookings        → []
 *   - tradepros.busyDays        → []
 *   - sites.tradesNeeded[].assigned    → false
 *   - sites.tradesNeeded[].tradeProId  → null
 *   - messages (all)            → deleted
 *
 * Run:
 *   node server/scripts/cleanBookings.js
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('MONGO_URI not set in .env'); process.exit(1); }

await mongoose.connect(MONGO_URI);
console.log('Connected to MongoDB');

const db = mongoose.connection.db;

// 1. Clear bookings and busyDays on all trade pros
const tradeProsResult = await db.collection('tradepros').updateMany(
  {},
  { $set: { bookings: [], busyDays: [] } }
);
console.log(`tradepros — cleared bookings + busyDays on ${tradeProsResult.modifiedCount} document(s)`);

// 2. Reset assigned + tradeProId on every tradesNeeded entry in sites
const sitesResult = await db.collection('sites').updateMany(
  { 'tradesNeeded.0': { $exists: true } },
  {
    $set: {
      'tradesNeeded.$[elem].assigned':   false,
      'tradesNeeded.$[elem].tradeProId': null,
    },
  },
  { arrayFilters: [{ 'elem.assigned': { $exists: true } }] }
);
console.log(`sites       — reset tradesNeeded on ${sitesResult.modifiedCount} document(s)`);

// 3. Delete all messages
const messagesResult = await db.collection('messages').deleteMany({});
console.log(`messages    — deleted ${messagesResult.deletedCount} document(s)`);

await mongoose.disconnect();
console.log('\nDone. All booking data cleared.');
