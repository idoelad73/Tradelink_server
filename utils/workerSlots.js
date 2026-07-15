import Message from '../models/Message.js';

// 'availability' is intentionally excluded — approveMessage() ALWAYS spawns a
// 'worker_offer' successor the moment an availability request is approved (the
// availability message itself immediately becomes status:'approved' too, but it
// never represents a standalone commitment — it's always superseded by that
// worker_offer). Counting it here would double-book the same real-world slot:
// once for the availability message and again once the worker_offer is approved.
const COMMITMENT_TYPES = ['application', 'worker_offer'];

/**
 * Sums workersOffered across every message for a given site + trade slot
 * that counts as "committed" (matches the given statuses). tradesNeeded's
 * workers_no is a fixed total (set once by the contractor) — a slot can be
 * filled by several different trade pros, so remaining capacity has to be
 * computed live from the messages collection rather than a mutable counter.
 */
export async function getWorkersCommitted(siteId, tradeName, statuses = ['accepted', 'approved'], excludeTradeProId = null) {
  if (!siteId || !tradeName) return 0;
  const query = {
    site:      siteId,
    type:      { $in: COMMITMENT_TYPES },
    status:    { $in: statuses },
    tradeName: { $regex: new RegExp(`^${tradeName}$`, 'i') },
  };
  if (excludeTradeProId) query.tradePro = { $ne: excludeTradeProId };
  const msgs = await Message.find(query).select('workersOffered tradePro requestedDate type').lean();

  // Safety net: dedupe by trade pro + date in case a trade pro somehow has both an
  // approved 'application' and an approved 'worker_offer' for the same day (should
  // not normally happen since they're separate flows, but avoids any double-count).
  const rank = { worker_offer: 2, application: 1 };
  const bestByKey = new Map();
  for (const m of msgs) {
    const key = `${m.tradePro}_${m.requestedDate}`;
    const existing = bestByKey.get(key);
    if (!existing || (rank[m.type] ?? 0) > (rank[existing.type] ?? 0)) {
      bestByKey.set(key, m);
    }
  }
  return [...bestByKey.values()].reduce((sum, m) => sum + (m.workersOffered ?? 1), 0);
}
