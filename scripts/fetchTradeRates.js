/**
 * Builds server/data/tradeRates.json from the US Bureau of Labor Statistics
 * (OEWS, national, all industries). Run from server/ directory:
 *   node scripts/fetchTradeRates.js
 *
 * BLS publishes what tradespeople EARN as employees (25th / median / 75th
 * percentile hourly wage). What an independent pro BILLS a customer is higher —
 * overhead, insurance, travel, profit — so the typical rate shown in the app is
 * the 25th–75th wage range × BILL_MULTIPLIER, rounded to the nearest $5.
 *
 * No API key needed (v1 allows 25 series per request, 25 requests per day).
 * Data is annual — re-run once a year, then `node --env-file=.env scripts/seedTradeRates.js`.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const BILL_MULTIPLIER = 1.9;

// App trade → BLS SOC code. Trades with no exact SOC use the closest one.
const SOC = {
  'Electrician':                '47-2111',
  'Plumber':                    '47-2152',
  'HVAC Technician':            '49-9021',
  'Carpenter':                  '47-2031',
  'Painter':                    '47-2141',
  'Roofer':                     '47-2181',
  'Mason / Bricklayer':         '47-2021',
  'Flooring Specialist':        '47-2042',
  'Tile Setter':                '47-2044',
  'Welder':                     '51-4121',
  'Landscaper':                 '37-3011',
  'Pest Control':               '37-2021',
  'Locksmith':                  '49-9094',
  'Glazier / Window Installer': '47-2121',
  'Drywall / Plasterer':        '47-2081',
  'Insulation Specialist':      '47-2131',
  'Concrete & Foundation':      '47-2051',
  'Pool & Spa Technician':      '49-9071', // closest: general maintenance & repair
  'Solar Panel Installer':      '47-2231',
  'Garage Door Specialist':     '49-9011',
  'Handyman':                   '49-9071',
  'Demolition Contractor':      '47-2061', // closest: construction laborers
};

// OEWS datatype codes: 07 = hourly 25th pct, 08 = hourly median, 09 = hourly 75th pct
const DATATYPES = { p25: '07', median: '08', p75: '09' };

const seriesId = (soc, dt) => `OEUN0000000000000${soc.replace('-', '')}${dt}`;
const round5   = (n) => Math.round(n / 5) * 5;

async function fetchSeries(ids) {
  const res  = await fetch('https://api.bls.gov/publicAPI/v1/timeseries/data/', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ seriesid: ids }),
  });
  const json = await res.json();
  if (json.status !== 'REQUEST_SUCCEEDED') throw new Error(`BLS: ${json.message?.join('; ')}`);
  const out = {};
  for (const s of json.Results.series) {
    const latest = s.data.find((d) => d.latest === 'true') ?? s.data[0];
    if (latest) out[s.seriesID] = { value: parseFloat(latest.value), year: Number(latest.year) };
  }
  return out;
}

const allIds = Object.values(SOC).flatMap((soc) => Object.values(DATATYPES).map((dt) => seriesId(soc, dt)));
const unique = [...new Set(allIds)];
const values = {};
for (let i = 0; i < unique.length; i += 25) {
  Object.assign(values, await fetchSeries(unique.slice(i, i + 25)));
}

const rates = Object.entries(SOC).map(([trade, soc]) => {
  const get = (dt) => values[seriesId(soc, dt)];
  const p25 = get(DATATYPES.p25), med = get(DATATYPES.median), p75 = get(DATATYPES.p75);
  if (!p25 || !med || !p75) throw new Error(`Missing BLS data for ${trade} (${soc})`);
  return {
    trade,
    soc,
    wageP25:    p25.value,
    wageMedian: med.value,
    wageP75:    p75.value,
    rateLow:    round5(p25.value * BILL_MULTIPLIER),
    rateHigh:   round5(p75.value * BILL_MULTIPLIER),
    year:       med.year,
  };
});

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'tradeRates.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({
  source:         'US Bureau of Labor Statistics, OEWS national hourly wages',
  billMultiplier: BILL_MULTIPLIER,
  rates,
}, null, 2) + '\n');

for (const r of rates) console.log(`${r.trade.padEnd(28)} $${r.rateLow}–${r.rateHigh}/hr  (wage $${r.wageP25}–${r.wageP75}, ${r.year})`);
console.log(`\nWrote ${rates.length} trades → ${outPath}`);
