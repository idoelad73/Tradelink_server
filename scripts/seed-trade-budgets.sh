#!/usr/bin/env bash
# Randomly assigns budgetType + value to every trade in every site document.
# Skips trades that already have a budgetType set.
#
# Usage:
#   chmod +x seed-trade-budgets.sh
#   ./seed-trade-budgets.sh
#
# Set your connection string here or pass it as an argument:
#   ./seed-trade-budgets.sh "mongodb+srv://user:pass@cluster.mongodb.net/dbname"

MONGO_URI="${1:-mongodb://localhost:27017/test}"

mongosh "$MONGO_URI" --eval '
const sites = db.sites.find({}).toArray();
let updated = 0;

for (const site of sites) {
  if (!Array.isArray(site.tradesNeeded) || site.tradesNeeded.length === 0) continue;

  const newTrades = site.tradesNeeded.map((trade) => {
    if (trade.budgetType) return trade;

    const useAmount = Math.random() > 0.5;
    if (useAmount) {
      const amount = Math.floor(Math.random() * 151) * 50 + 500;
      return { ...trade, budgetType: "amount", maxAmount: amount, totalHours: null };
    } else {
      const hours = Math.floor(Math.random() * 29) * 4 + 8;
      return { ...trade, budgetType: "hours", maxAmount: null, totalHours: hours };
    }
  });

  db.sites.updateOne({ _id: site._id }, { $set: { tradesNeeded: newTrades } });
  updated++;

  const summary = newTrades.map(t =>
    t.budgetType === "amount" ? `${t.name} $${t.maxAmount}` : `${t.name} ${t.totalHours}h`
  ).join(", ");
  print(`Updated: "${site.name}" — ${summary}`);
}

print(`\nDone — ${updated} site(s) updated.`);
'
