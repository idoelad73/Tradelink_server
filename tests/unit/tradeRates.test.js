import { describe, it, expect } from 'vitest';
import { TRADE_RATES, missingTradeRates } from '../../utils/tradeRates.js';
import { TRADE_PROFESSIONALITIES } from '../../../client/src/constants/trades.js';

describe('data/tradeRates.json', () => {
  it('has a typical rate for every trade the app offers', () => {
    expect(missingTradeRates(TRADE_PROFESSIONALITIES)).toEqual([]);
  });

  it('every rate is a sane low–high range', () => {
    for (const r of TRADE_RATES) {
      expect(r.rateLow, r.trade).toBeGreaterThan(0);
      expect(r.rateHigh, r.trade).toBeGreaterThanOrEqual(r.rateLow);
    }
  });
});
