/**
 * fixLocationCoordinates.js
 *
 * Converts any Int32 coordinates in the tradepros collection to Double (float64).
 * MongoDB's 2dsphere index requires float64 — Int32 values cause geo-query failures.
 *
 * Run:
 *   node --experimental-vm-modules server/scripts/fixLocationCoordinates.js
 * or simply:
 *   node server/scripts/fixLocationCoordinates.js
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE_URL;
if (!MONGO_URI) {
  console.error('❌  MONGO_URI not found in .env');
  process.exit(1);
}

await mongoose.connect(MONGO_URI);
console.log('✅  Connected to MongoDB');

const db   = mongoose.connection.db;
const coll = db.collection('tradepros');

// ── Step 1: report current state ──────────────────────────────────────────────
const total    = await coll.countDocuments({});
const hasCoord = await coll.countDocuments({ 'location.coordinates': { $exists: true } });
console.log(`\n📊  tradepros total: ${total}  |  with coordinates: ${hasCoord}`);

import { Double } from 'mongodb';

// ── Step 2a: convert non-zero Int32 → Double via aggregation pipeline ─────────
// $toDouble coerces any BSON numeric type to float64.
// This works for non-zero values (value changes → MongoDB writes the update).
const result = await coll.updateMany(
  { 'location.coordinates': { $exists: true, $not: { $size: 0 } } },
  [{
    $set: {
      'location.type': 'Point',
      'location.coordinates': {
        $map: {
          input: '$location.coordinates',
          as:    'c',
          in:    { $toDouble: '$$c' },
        },
      },
    },
  }]
);
console.log(`\n✅  Step 2a: Updated ${result.modifiedCount} document(s) (matched ${result.matchedCount})`);

// ── Step 2b: fix [0, 0] Int32 via two-step workaround ────────────────────────
// MongoDB's numeric-equality no-op check treats Int32(0) == Double(0.0) as "no change".
// Trick: change value to [0.1, 0.1] first (forces a real write), then back to [0.0, 0.0] as Double.
const zeroFilter = { 'location.coordinates.0': 0, 'location.coordinates.1': 0 };
const zeroCount  = await coll.countDocuments(zeroFilter);
console.log(`\n🔧  Step 2b: ${zeroCount} document(s) with [0, 0] coordinates need two-step fix…`);

if (zeroCount > 0) {
  // Step i: set to sentinel [0.1, 0.1]  (value change → MongoDB applies update → stores as Double)
  await coll.updateMany(zeroFilter, {
    $set: { 'location.coordinates': [new Double(0.1), new Double(0.1)] },
  });
  // Step ii: set back to [0.0, 0.0] Double  (0.1 → 0.0 is a value change → stored as Double)
  await coll.updateMany(
    { 'location.coordinates.0': 0.1, 'location.coordinates.1': 0.1 },
    { $set: { 'location.coordinates': [new Double(0), new Double(0)] } }
  );
  console.log(`    Converted ${zeroCount} [0,0] Int32 → [0.0, 0.0] Double ✅`);
}

// ── Step 3: verify a sample ───────────────────────────────────────────────────
const sample = await coll.findOne(
  { 'location.coordinates': { $exists: true, $not: { $size: 0 } } },
  { projection: { fullName: 1, 'location.type': 1, 'location.coordinates': 1 } }
);

if (sample) {
  console.log('\n🔍  Sample after fix:');
  console.log(`    name        : ${sample.fullName}`);
  console.log(`    type        : ${sample.location?.type}`);
  console.log(`    coordinates : ${JSON.stringify(sample.location?.coordinates)}`);
} else {
  console.log('\n⚠️   No documents with coordinates found after update.');
}

// ── Step 4: drop & rebuild 2dsphere index so it sees the corrected types ──────
console.log('\n🔄  Rebuilding 2dsphere index…');
try {
  await coll.dropIndex('location_2dsphere');
  console.log('    Dropped old index.');
} catch {
  console.log('    No existing 2dsphere index to drop (or already gone).');
}

await coll.createIndex({ location: '2dsphere' });
console.log('    Created fresh 2dsphere index. ✅');

await mongoose.disconnect();
console.log('\n🏁  Done — connection closed.\n');
