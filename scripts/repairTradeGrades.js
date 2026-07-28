/**
 * Repair script — run once from server/ directory:
 *   node --env-file=.env scripts/repairTradeGrades.js
 *   node --env-file=.env scripts/repairTradeGrades.js --apply
 *
 * Without --apply it reports what it would do and changes nothing.
 *
 * Why this is needed alongside the code fix:
 *
 *  1. The old unique index { contractor_id, order_id } is still present on the
 *     live database. Mongoose creates new indexes but never drops removed ones,
 *     so until it goes the second party to rate a job still gets a duplicate-key
 *     error — the code fix alone does nothing.
 *
 *  2. avgGrade / gradeCount on TradePro were computed without a grade_type
 *     filter, so every pro who reviewed a contractor has a polluted score. Those
 *     denormalised values are recomputed here from the grade documents.
 *
 * What it CANNOT do: reviews destroyed by the overwrite bug are gone. Only one
 * document ever existed per order, and the losing side's text was replaced in
 * place. This script reports how many orders look like they lost a review, but
 * it cannot bring them back.
 */

import mongoose from 'mongoose';
import '../models/Site.js';
import TradeGrade from '../models/TradeGrade.js';
import TradePro from '../models/TradePro.js';
import Contractor from '../models/Contractor.js';
import WorkHoursOrder from '../models/WorkHoursOrder.js';

const MONGO_URI  = process.env.MONGO_URI;
const APPLY      = process.argv.includes('--apply');
const STALE_INDEX = 'contractor_id_1_order_id_1';

if (!MONGO_URI) { console.error('MONGO_URI not set'); process.exit(1); }

const log = (...a) => console.log(...a);

async function dropStaleIndex(col) {
  const indexes = await col.indexes();
  const stale   = indexes.find(i => i.name === STALE_INDEX);

  if (!stale) {
    log(`  ✓ stale index ${STALE_INDEX} already gone`);
    return;
  }

  log(`  ! found stale unique index ${STALE_INDEX} — this is what blocks the second rating`);
  if (!APPLY) { log('    (dry run — would drop it)'); return; }

  await col.dropIndex(STALE_INDEX);
  log(`    dropped ${STALE_INDEX}`);
}

/**
 * The new index is unique on (order_id, grade_type). Refuse to create it while
 * duplicates exist rather than letting createIndex fail halfway.
 */
async function findIndexConflicts() {
  return TradeGrade.aggregate([
    { $match: { order_id: { $type: 'objectId' } } },
    { $group: { _id: { order_id: '$order_id', grade_type: '$grade_type' }, n: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { n: { $gt: 1 } } },
  ]);
}

async function ensureNewIndex(col) {
  const conflicts = await findIndexConflicts();
  if (conflicts.length) {
    log(`  ✗ ${conflicts.length} (order_id, grade_type) pair(s) have duplicate rows.`);
    log('    Resolve these by hand before the unique index can be built:');
    conflicts.slice(0, 20).forEach(c =>
      log(`      order ${c._id.order_id} / ${c._id.grade_type}: ${c.ids.join(', ')}`));
    return false;
  }

  log('  ✓ no duplicate (order_id, grade_type) pairs');
  if (!APPLY) { log('    (dry run — would build the new unique index)'); return true; }

  await col.createIndex(
    { order_id: 1, grade_type: 1 },
    { unique: true, partialFilterExpression: { order_id: { $type: 'objectId' } } }
  );
  log('    built unique index order_id_1_grade_type_1');
  return true;
}

/** Recompute one side's denormalised average from the grade documents. */
async function recompute({ label, Model, groupField, gradeType }) {
  const aggs = await TradeGrade.aggregate([
    { $match: { grade_type: gradeType } },
    { $group: { _id: `$${groupField}`, avg: { $avg: '$trade_grade' }, count: { $sum: 1 } } },
  ]);

  const correct = new Map(aggs.map(a => [String(a._id), {
    avgGrade:   Math.round(a.avg * 10) / 10,
    gradeCount: a.count,
  }]));

  const all     = await Model.find({}).select('avgGrade gradeCount').lean();
  const changes = [];

  for (const doc of all) {
    // Nobody has rated them under the corrected rules — reset to "no reviews".
    const want = correct.get(String(doc._id)) ?? { avgGrade: null, gradeCount: 0 };
    const has  = { avgGrade: doc.avgGrade ?? null, gradeCount: doc.gradeCount ?? 0 };

    if (has.avgGrade !== want.avgGrade || has.gradeCount !== want.gradeCount) {
      changes.push({ _id: doc._id, from: has, to: want });
    }
  }

  log(`  ${label}: ${changes.length} of ${all.length} need correcting`);
  changes.slice(0, 15).forEach(c =>
    log(`    ${c._id}: ${c.from.avgGrade}★/${c.from.gradeCount} → ${c.to.avgGrade}★/${c.to.gradeCount}`));
  if (changes.length > 15) log(`    …and ${changes.length - 15} more`);

  if (APPLY && changes.length) {
    await Model.bulkWrite(changes.map(c => ({
      updateOne: { filter: { _id: c._id }, update: { $set: c.to } },
    })));
    log(`    applied ${changes.length} update(s)`);
  }
}

/** Rows whose order no longer exists, or that never referenced a real order. */
async function reportOrphans() {
  const withOrder = await TradeGrade.find({ order_id: { $type: 'objectId' } }).select('order_id').lean();
  const orderIds  = [...new Set(withOrder.map(g => String(g.order_id)))];
  const existing  = await WorkHoursOrder.find({ _id: { $in: orderIds } }).select('_id').lean();
  const alive     = new Set(existing.map(o => String(o._id)));

  const orphaned = orderIds.filter(id => !alive.has(id));
  const nullOrder = await TradeGrade.countDocuments({ order_id: null });

  log(`  grades pointing at a deleted order: ${orphaned.length}`);
  log(`  grades with no order_id at all:     ${nullOrder}`);
  log('  (left in place — they still carry review text; delete by hand if unwanted)');
}

/** How many approved orders ended up with only one side's review on record. */
async function reportLostReviews() {
  const [approved, byType] = await Promise.all([
    WorkHoursOrder.countDocuments({ status: 'approved' }),
    TradeGrade.aggregate([
      { $match: { order_id: { $type: 'objectId' } } },
      { $group: { _id: '$grade_type', n: { $sum: 1 } } },
    ]),
  ]);

  const counts = Object.fromEntries(byType.map(b => [b._id, b.n]));
  log(`  approved orders:              ${approved}`);
  log(`  'trade' grades on record:     ${counts.trade      ?? 0}`);
  log(`  'contractor' grades on record:${counts.contractor ?? 0}`);
  log('  Any order that was rated by both sides before the fix kept only the');
  log('  later review. Those texts are unrecoverable.');
}

async function main() {
  await mongoose.connect(MONGO_URI);
  log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}\n`);

  const col = mongoose.connection.collection('trade_grades');

  log('1. Indexes');
  await dropStaleIndex(col);
  const indexOk = await ensureNewIndex(col);

  log('\n2. Recomputing denormalised averages');
  if (!indexOk) {
    log('  skipped — resolve the duplicates above first');
  } else {
    await recompute({ label: 'TradePro  ', Model: TradePro,   groupField: 'trade_id',      gradeType: 'trade' });
    await recompute({ label: 'Contractor', Model: Contractor, groupField: 'contractor_id', gradeType: 'contractor' });
  }

  log('\n3. Data health');
  await reportOrphans();

  log('\n4. Reviews lost to the overwrite bug');
  await reportLostReviews();

  log(`\nDone.${APPLY ? '' : ' Nothing was written — re-run with --apply.'}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('FAILED:', err);
  await mongoose.disconnect();
  process.exit(1);
});
