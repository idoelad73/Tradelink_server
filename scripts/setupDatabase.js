/**
 * Builds the TradeLink schema on an empty database — the same collections and
 * indexes as development, no data. Run from server/ directory:
 *
 *   node --env-file=.env.production scripts/setupDatabase.js           (dry run)
 *   node --env-file=.env.production scripts/setupDatabase.js --apply
 *
 * MongoDB has no fixed schema: what makes two databases "the same" is the set of
 * collections and their indexes (unique keys, the 2dsphere geo indexes the job /
 * trade search needs, partial unique indexes on messages and trade_grades). All
 * of that is defined in models/, so this creates each collection and syncs its
 * indexes from the model. Safe to re-run.
 *
 * Note: syncIndexes also DROPS indexes that are not in the models — that is the
 * point on a fresh database, but don't aim this at a database you haven't checked.
 *
 * Afterwards, seed the reference data:
 *   node --env-file=.env.production scripts/seedTradeRates.js
 */

import mongoose from 'mongoose';
import Chat from '../models/Chat.js';
import Contractor from '../models/Contractor.js';
import Counter from '../models/Counter.js';
import Message from '../models/Message.js';
import Receipt from '../models/Receipt.js';
import Site from '../models/Site.js';
import TradeGrade from '../models/TradeGrade.js';
import TradePro from '../models/TradePro.js';
import TradeRate from '../models/TradeRate.js';
import WorkHoursOrder from '../models/WorkHoursOrder.js';
// Not included: Application (replaced by Message, no longer used) and User (empty stub).

const MODELS = [Chat, Contractor, Counter, Message, Receipt, Site, TradeGrade, TradePro, TradeRate, WorkHoursOrder];

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('MONGO_URI not set'); process.exit(1); }
const APPLY = process.argv.includes('--apply');

await mongoose.connect(MONGO_URI, { autoIndex: false });
try {
  const db = mongoose.connection;
  console.log(`Target: ${db.host} / database "${db.name}"${APPLY ? '' : '  (dry run — add --apply to write)'}\n`);
  if (db.name === 'test') {
    console.error('Database name is "test" — the URI is missing /tradelink before the "?". Aborting.');
    process.exit(1);
  }

  const existing = new Set((await db.db.listCollections().toArray()).map((c) => c.name));

  for (const Model of MODELS) {
    const name    = Model.collection.collectionName;
    const indexes = Model.schema.indexes().map(([keys, opts]) =>
      `${JSON.stringify(keys)}${opts?.unique ? ' unique' : ''}${opts?.partialFilterExpression ? ' partial' : ''}`);
    console.log(`${existing.has(name) ? '✓ exists ' : '+ create '} ${name}`);
    indexes.forEach((i) => console.log(`      index ${i}`));

    if (APPLY) {
      if (!existing.has(name)) await Model.createCollection();
      const dropped = await Model.syncIndexes();
      if (dropped?.length) console.log(`      dropped indexes not in the model: ${dropped.join(', ')}`);
    }
  }

  console.log(`\n${MODELS.length} collections ${APPLY ? 'ready' : 'checked'}.`);
} finally {
  await mongoose.disconnect();
}
