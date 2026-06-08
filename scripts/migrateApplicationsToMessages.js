/**
 * migrateApplicationsToMessages.js
 *
 * One-time migration: merges the `applications` collection into `messages`.
 *
 * What it does:
 *  1. Each Application document becomes a Message with type:'application'
 *  2. Old Message documents with type:'availability' + senderType:'trade'
 *     (which were actually reschedule requests) get type:'reschedule'
 *  3. Drops the now-redundant `applications` collection
 *
 * Run: node server/scripts/migrateApplicationsToMessages.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) { console.error('❌  No MONGO_URI in .env'); process.exit(1); }

await mongoose.connect(MONGO_URI);
console.log('✅  Connected\n');

const apps  = mongoose.connection.collection('applications');
const msgs  = mongoose.connection.collection('messages');

// ── 1. Convert applications → messages ───────────────────────────────────────
const existing = await apps.find({}).toArray();
console.log(`Found ${existing.length} application(s) to migrate`);

let inserted = 0, skipped = 0;
for (const app of existing) {
  // Skip if a message of type:'application' for this tradePro+site already exists
  const already = await msgs.findOne({ tradePro: app.tradePro, site: app.site, type: 'application' });
  if (already) { skipped++; continue; }

  await msgs.insertOne({
    tradePro:      app.tradePro,
    site:          app.site,
    contractor:    app.contractor,
    requestedDate: app.scheduledDate || '',
    text:          '',
    status:        app.status === 'accepted' ? 'accepted'
                 : app.status === 'rejected' ? 'rejected'
                 : 'pending',
    type:          'application',
    senderType:    'trade',
    createdAt:     app.createdAt ?? new Date(),
    updatedAt:     app.updatedAt ?? new Date(),
  });
  inserted++;
}
console.log(`  Migrated  : ${inserted}`);
console.log(`  Skipped   : ${skipped} (already existed)`);

// ── 2. Rename old reschedule messages (type:'availability', senderType:'trade') ─
const rescheduleFix = await msgs.updateMany(
  { type: 'availability', senderType: 'trade' },
  { $set: { type: 'reschedule' } }
);
console.log(`\nReschedule messages updated: ${rescheduleFix.modifiedCount}`);

// ── 3. Fix old messages missing `type` field (set to 'availability') ──────────
const missingType = await msgs.updateMany(
  { type: { $exists: false } },
  { $set: { type: 'availability' } }
);
console.log(`Messages with missing type fixed: ${missingType.modifiedCount}`);

// ── 4. Drop applications collection ──────────────────────────────────────────
await apps.drop().catch(() => console.log('  (applications collection already gone)'));
console.log('\nApplications collection dropped.');

console.log('\n🎉  Migration complete!');
await mongoose.disconnect();
