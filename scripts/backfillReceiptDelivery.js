/**
 * Backfill script — run once from server/ directory:
 *   node --env-file=.env scripts/backfillReceiptDelivery.js
 *   node --env-file=.env scripts/backfillReceiptDelivery.js --apply
 *
 * Without --apply it reports what it would do and changes nothing.
 *
 * Why this is needed:
 *
 * Receipt now carries emailedAt / deliveryError / pdfAttached. Existing rows
 * predate those fields, and in MongoDB `{ emailedAt: null }` also matches
 * documents where the field is simply absent — so without a backfill every
 * historical receipt looks like it was never delivered, and any resend pass
 * built on that query would re-send years of receipts.
 *
 * The only historical signal for delivery is WorkHoursOrder.receiptSent, which
 * the old code set after the contractor's receipt email went out. So:
 *
 *   order.receiptSent === true  → emailedAt = receipt.createdAt, pdfAttached = true
 *   otherwise                   → left null, flagged as genuinely unknown
 *
 * Receipts left null are NOT asserted to have failed — they are unknown. Review
 * the list before wiring up any automated resend.
 */

import mongoose from 'mongoose';
import Receipt from '../models/Receipt.js';
import WorkHoursOrder from '../models/WorkHoursOrder.js';

const MONGO_URI = process.env.MONGO_URI;
const APPLY     = process.argv.includes('--apply');

if (!MONGO_URI) { console.error('MONGO_URI not set'); process.exit(1); }

const log = (...a) => console.log(...a);

async function main() {
  await mongoose.connect(MONGO_URI);
  log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}\n`);

  // Only touch rows written before the field existed. A row where the field is
  // present — even as null — was produced by the new code and already correct.
  const legacy = await Receipt.find({ emailedAt: { $exists: false } })
    .select('receipt_number order_id createdAt')
    .lean();

  log(`Legacy receipts (no emailedAt field): ${legacy.length}`);
  if (!legacy.length) {
    log('Nothing to backfill.');
    await mongoose.disconnect();
    return;
  }

  const orderIds = [...new Set(legacy.map(r => String(r.order_id)).filter(Boolean))];
  const orders   = await WorkHoursOrder.find({ _id: { $in: orderIds } })
    .select('receiptSent').lean();
  const sentOrders = new Set(orders.filter(o => o.receiptSent === true).map(o => String(o._id)));

  const delivered = legacy.filter(r => sentOrders.has(String(r.order_id)));
  const unknown   = legacy.filter(r => !sentOrders.has(String(r.order_id)));

  log(`  → treat as delivered (order.receiptSent = true): ${delivered.length}`);
  log(`  → leave as unknown:                              ${unknown.length}`);

  if (unknown.length) {
    log('\nUnknown — check these before enabling any automated resend:');
    unknown.slice(0, 20).forEach(r => log(`  ${r.receipt_number}  order=${r.order_id ?? '—'}`));
    if (unknown.length > 20) log(`  …and ${unknown.length - 20} more`);
  }

  if (!APPLY) {
    log('\nNothing written — re-run with --apply.');
    await mongoose.disconnect();
    return;
  }

  if (delivered.length) {
    await Receipt.bulkWrite(delivered.map(r => ({
      updateOne: {
        filter: { _id: r._id },
        // createdAt is the closest honest timestamp we have — the old code sent
        // the email moments after writing the row.
        update: { $set: { emailedAt: r.createdAt, deliveryError: null, pdfAttached: true } },
      },
    })));
    log(`\nMarked ${delivered.length} receipt(s) as delivered.`);
  }

  if (unknown.length) {
    await Receipt.bulkWrite(unknown.map(r => ({
      updateOne: {
        filter: { _id: r._id },
        update: { $set: { emailedAt: null, deliveryError: 'unknown — predates delivery tracking', pdfAttached: false } },
      },
    })));
    log(`Flagged ${unknown.length} receipt(s) as unknown.`);
  }

  log('\nDone.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('FAILED:', err);
  await mongoose.disconnect();
  process.exit(1);
});
