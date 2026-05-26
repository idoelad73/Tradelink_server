// mongosh script — run with:
//   mongosh "your-connection-string" --file seed-trade-budgets.js
//
// Randomly assigns budgetType + value to every trade in every site document.
// Skips trades that already have a budgetType set.

const db = db.getSiblingDB('test'); // ← change to your DB name if different

const sites = db.sites.find({}).toArray();
let updated = 0;

for (const site of sites) {
  if (!Array.isArray(site.tradesNeeded) || site.tradesNeeded.length === 0) continue;

  const newTrades = site.tradesNeeded.map((trade) => {
    // Skip if already has budget data
    if (trade.budgetType) return trade;

    const useAmount = Math.random() > 0.5;

    if (useAmount) {
      // Random amount between $500 and $8000 (rounded to nearest $50)
      const raw    = Math.floor(Math.random() * 151) * 50 + 500;
      return { ...trade, budgetType: 'amount', maxAmount: raw, totalHours: null };
    } else {
      // Random hours between 8 and 120 (rounded to nearest 4h)
      const raw    = Math.floor(Math.random() * 29) * 4 + 8;
      return { ...trade, budgetType: 'hours', maxAmount: null, totalHours: raw };
    }
  });

  db.sites.updateOne(
    { _id: site._id },
    { $set: { tradesNeeded: newTrades } }
  );
  updated++;
  print(`Updated site: "${site.name}" — trades: ${newTrades.map(t =>
    t.budgetType === 'amount' ? `${t.name} $${t.maxAmount}` : `${t.name} ${t.totalHours}h`
  ).join(', ')}`);
}

print(`\nDone — ${updated} site(s) updated.`);
