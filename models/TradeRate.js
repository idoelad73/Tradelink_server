import mongoose from 'mongoose';

// Typical market hourly rate per trade — seeded from data/tradeRates.json
// (scripts/fetchTradeRates.js → scripts/seedTradeRates.js).
const tradeRateSchema = new mongoose.Schema(
  {
    trade:      { type: String, required: true, unique: true }, // matches TradePro.professionality
    soc:        { type: String, default: null },                // BLS occupation code
    wageP25:    { type: Number, default: null },                // BLS employee wage, 25th pct
    wageMedian: { type: Number, default: null },
    wageP75:    { type: Number, default: null },
    rateLow:    { type: Number, required: true },               // typical billed rate shown in the app
    rateHigh:   { type: Number, required: true },
    year:       { type: Number, default: null },
  },
  { timestamps: true, collection: 'trade_rates' }
);

export default mongoose.model('TradeRate', tradeRateSchema);
