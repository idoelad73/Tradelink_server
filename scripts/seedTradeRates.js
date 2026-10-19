/**
 * Seeds the trade_rates collection from data/tradeRates.json. Run from server/:
 *   node --env-file=.env scripts/seedTradeRates.js
 *
 * Upserts one document per trade (safe to re-run). Refuses to run if any trade
 * the app offers is missing from the JSON, so every trade always has a rate.
 */

import mongoose from 'mongoose';
import TradeRate from '../models/TradeRate.js';
import { TRADE_RATES, missingTradeRates } from '../utils/tradeRates.js';
import { TRADE_PROFESSIONALITIES } from '../../client/src/constants/trades.js';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('MONGO_URI not set'); process.exit(1); }

const missing = missingTradeRates(TRADE_PROFESSIONALITIES);
if (missing.length) {
  console.error(`No rate in data/tradeRates.json for: ${missing.join(', ')}`);
  process.exit(1);
}

await mongoose.connect(MONGO_URI);
try {
  const res = await TradeRate.bulkWrite(TRADE_RATES.map((r) => ({
    updateOne: { filter: { trade: r.trade }, update: { $set: r }, upsert: true },
  })));
  console.log(`trade_rates: ${res.upsertedCount} inserted, ${res.modifiedCount} updated, ${TRADE_RATES.length} total`);
} finally {
  await mongoose.disconnect();
}
