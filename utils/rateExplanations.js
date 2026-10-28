import Message, { RATE_EXPLANATION_TYPE } from '../models/Message.js';
import Site from '../models/Site.js';

const MAX_SYNC_PASSES = 5;

// tradeName → comment text for every slot that has a comment.
function desiredExplanations(site) {
  const map = new Map();
  for (const t of site?.tradesNeeded ?? []) {
    const text = t.rateComment?.trim();
    if (text) map.set(t.name, text);
  }
  return map;
}

const sameMap = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/**
 * Keeps the messages collection in step with Site.tradesNeeded[].rateComment.
 *
 * The comment is still read from the site (job search, project cards), but every
 * write path — create/update site, the rate-comment endpoints — ends here so the
 * `total_hours_explanations` messages always mirror it: one message per trade
 * slot that has a comment, none for slots without one or slots that were removed.
 *
 * Concurrency: two overlapping saves on the same site used to leave the mirror
 * missing a comment — each request rebuilt the set from its OWN snapshot and then
 * deleted everything outside it, so a late cleanup wiped a message the other
 * request had just written. Now every pass reads the site fresh from the DB, and
 * after applying it re-reads; if the site changed underneath, it runs again. Any
 * request whose delete was based on a stale snapshot therefore sees the
 * difference on its own re-check and repairs it. No lock needed, so this holds
 * across multiple server instances too.
 *
 * @param {object} site  the site document (only its _id is used; state is re-read)
 */
export async function syncRateExplanations(site) {
  const siteId = site._id;

  for (let pass = 1; pass <= MAX_SYNC_PASSES; pass++) {
    const fresh = await Site.findById(siteId).select('contractor tradesNeeded').lean();
    if (!fresh) {
      await deleteRateExplanationsForSite(siteId); // site deleted mid-flight
      return;
    }

    const desired = desiredExplanations(fresh);

    await Promise.all([...desired].map(([tradeName, text]) =>
      Message.findOneAndUpdate(
        { site: siteId, tradeName, type: RATE_EXPLANATION_TYPE },
        {
          $set: { text, contractor: fresh.contractor },
          $setOnInsert: { senderType: 'contractor', status: 'approved' },
        },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
      )
    ));

    await Message.deleteMany({
      site: siteId,
      type: RATE_EXPLANATION_TYPE,
      tradeName: { $nin: [...desired.keys()] },
    });

    // Converged when the site is unchanged since this pass read it.
    const after = await Site.findById(siteId).select('tradesNeeded').lean();
    if (sameMap(desired, desiredExplanations(after))) return;
  }

  console.warn(`[rateExplanations] site ${siteId} still changing after ${MAX_SYNC_PASSES} passes — mirror may lag until the next save`);
}

// ── Non-fatal wrappers for request handlers ──────────────────────────────────
// The SITE is the source of truth; the messages are a derived copy that every
// sync fully recomputes. So once the site write has succeeded, a failure to
// update the copy must not turn the request into an error: the contractor's
// change DID save, and reporting a 500 invited a retry — which, on create,
// produced a duplicate project. The copy self-heals on the next successful sync
// for that site. Returns whether the sync succeeded.
export async function trySyncRateExplanations(site) {
  try {
    await syncRateExplanations(site);
    return true;
  } catch (err) {
    console.error(`[rateExplanations] sync failed for site ${site?._id} — site saved, mirror will catch up on next save: ${err.message}`);
    return false;
  }
}

export async function tryDeleteRateExplanationsForSite(siteId) {
  try {
    await deleteRateExplanationsForSite(siteId);
    return true;
  } catch (err) {
    console.error(`[rateExplanations] cleanup failed for deleted site ${siteId}: ${err.message}`);
    return false;
  }
}

export async function deleteRateExplanationsForSite(siteId) {
  await Message.deleteMany({ site: siteId, type: RATE_EXPLANATION_TYPE });
}
