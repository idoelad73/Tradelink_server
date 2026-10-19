import { readFileSync } from 'fs';
import TradeRate from '../models/TradeRate.js';

const json = JSON.parse(readFileSync(new URL('../data/tradeRates.json', import.meta.url), 'utf8'));

// Defaults from the JSON — used when the collection hasn't been seeded yet
export const TRADE_RATES = json.rates;

// Trades in `trades` that have no rate in the JSON
export const missingTradeRates = (trades) =>
  trades.filter((t) => !TRADE_RATES.some((r) => r.trade === t));

// DB rows win over JSON defaults, so every trade in the JSON always has a rate
export async function getAllTradeRates() {
  const rows   = await TradeRate.find({}).select('-_id -__v -createdAt -updatedAt').lean();
  const byName = new Map(TRADE_RATES.map((r) => [r.trade, r]));
  for (const r of rows) byName.set(r.trade, r);
  return [...byName.values()].sort((a, b) => a.trade.localeCompare(b.trade));
}
