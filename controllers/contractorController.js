import Contractor from '../models/Contractor.js';
import Site from '../models/Site.js';
import TradeGrade, { GRADE_NAMES_MAP } from '../models/TradeGrade.js';

// Normalises incoming tradesNeeded — accepts string array OR {name,assigned} object array
function normalizeTrades(raw) {
  const arr = Array.isArray(raw) ? raw : JSON.parse(raw);
  return arr.map((t) =>
    typeof t === 'string'
      ? {
          name: t, assigned: false,
          budgetType: null, maxAmount: null, totalHours: null, totalWorkingHrs: null,
          requiredDate: null, workers_no: null,
        }
      : {
          name:            t.name,
          assigned:        t.assigned        ?? false,
          tradeProId:      t.tradeProId      ?? null,
          budgetType:      t.budgetType      ?? null,
          maxAmount:       t.maxAmount       ?? null,
          totalHours:      t.totalHours      ?? null,
          totalWorkingHrs: t.totalWorkingHrs ?? null,   // ← was silently dropped before
          requiredDate:    t.requiredDate    ?? null,
          workers_no:      t.workers_no      ?? t.workersNeeded ?? null,
        }
  );
}
import TradePro from '../models/TradePro.js';
import Message from '../models/Message.js';
import WorkHoursOrder from '../models/WorkHoursOrder.js';
import { uploadPhoto } from '../utils/cloudinary.js';
import { geocodeAddress } from '../utils/geocode.js';
import jwt from 'jsonwebtoken';
import stripe from '../utils/stripe.js';

// GET /api/contractor/me
// Returns contractor profile + count of sites
export async function getMe(req, res, next) {
  try {
    const contractor = await Contractor.findById(req.userId).populate('sites', 'name type status');
    res.json({ contractor });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/contractor/me
export async function updateMe(req, res, next) {
  try {
    const { companyName, phone, address, expertise } = req.body;
    const updates = {};
    if (companyName !== undefined) updates.companyName = companyName;
    if (phone       !== undefined) updates.phone       = phone;
    if (address     !== undefined) updates.address     = address;
    if (expertise   !== undefined) {
      updates.expertise = Array.isArray(expertise) ? expertise : JSON.parse(expertise);
    }

    const contractor = await Contractor.findByIdAndUpdate(
      req.userId,
      updates,
      { new: true, runValidators: true }
    ).populate('sites', 'name type status');

    res.json({ contractor });
  } catch (err) {
    next(err);
  }
}

// POST /api/contractor/sites
// Creates site, stores full details, and pushes ref onto contractor.sites
export async function createSite(req, res, next) {
  try {
    const { name, type, address, tradesNeeded, notes } = req.body;

    let photo;
    if (req.file) {
      const result = await uploadPhoto(req.file.buffer, 'tradelink/sites');
      photo = result.secure_url;
    }

    const tradesArr = tradesNeeded ? normalizeTrades(tradesNeeded) : [];

    // Geocode address → GeoJSON coordinates (best-effort; falls back to [0,0])
    const coords = await geocodeAddress(address);
    const location = {
      type: 'Point',
      coordinates: coords ? [parseFloat(coords.lng), parseFloat(coords.lat)] : [0.0, 0.0],
    };

    // Create the site document
    const site = await Site.create({
      contractor: req.userId,
      name, type, address,
      tradesNeeded: tradesArr,
      notes: notes || '',
      photo,
      location,
    });

    // Maintain bidirectional reference on contractor
    await Contractor.findByIdAndUpdate(req.userId, { $push: { sites: site._id } });

    res.status(201).json({ site });
  } catch (err) {
    next(err);
  }
}

// GET /api/contractor/sites
// Returns all sites for the authenticated contractor with full details
export async function getSites(req, res, next) {
  try {
    const sites = await Site.find({ contractor: req.userId }).sort({ createdAt: -1 });

    // Find all confirmed deposit messages for this contractor
    const depositedMsgs = await Message.find({
      contractor: req.userId,
      type:       'payment',
      status:     'deposited',
    }).select('site tradeName min_deposit').lean();

    // Fast lookup: "siteId::tradeName" → { held, amount }
    const heldMap = new Map(
      depositedMsgs.map(m => [`${m.site}::${m.tradeName}`, m.min_deposit ?? null])
    );

    const sitesWithDeposit = sites.map(s => {
      const obj = s.toObject();
      obj.tradesNeeded = (obj.tradesNeeded || []).map(tr => {
        const key = `${obj._id}::${tr.name}`;
        return {
          ...tr,
          depositHeld:   heldMap.has(key),
          depositAmount: heldMap.get(key) ?? null,
        };
      });
      return obj;
    });

    res.json({ sites: sitesWithDeposit });
  } catch (err) {
    next(err);
  }
}

// GET /api/contractor/sites/:id
export async function getSite(req, res, next) {
  try {
    const site = await Site.findOne({ _id: req.params.id, contractor: req.userId });
    if (!site) return res.status(404).json({ message: 'Site not found' });
    res.json({ site });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/contractor/sites/:id
export async function updateSite(req, res, next) {
  try {
    const { name, type, address, tradesNeeded, notes, status } = req.body;
    const updates = {};
    if (name         !== undefined) updates.name    = name;
    if (type         !== undefined) updates.type    = type;
    if (address      !== undefined) updates.address = address;
    if (notes        !== undefined) updates.notes   = notes;
    if (status       !== undefined) updates.status  = status;
    if (tradesNeeded !== undefined) updates.tradesNeeded = normalizeTrades(tradesNeeded);

    if (req.file) {
      const result = await uploadPhoto(req.file.buffer, 'tradelink/sites');
      updates.photo = result.secure_url;
    }

    const site = await Site.findOneAndUpdate(
      { _id: req.params.id, contractor: req.userId },
      updates,
      { new: true, runValidators: true }
    );
    if (!site) return res.status(404).json({ message: 'Site not found' });
    res.json({ site });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/contractor/sites/:id
export async function deleteSite(req, res, next) {
  try {
    const site = await Site.findOneAndDelete({ _id: req.params.id, contractor: req.userId });
    if (!site) return res.status(404).json({ message: 'Site not found' });

    // Remove the reference from contractor.sites
    await Contractor.findByIdAndUpdate(req.userId, { $pull: { sites: site._id } });

    res.json({ message: 'Site deleted' });
  } catch (err) {
    next(err);
  }
}

// GET /api/contractor/sites/:siteId/workers-left?tradeName=Painter&date=2026-06-22
// Returns how many worker slots remain for a trade+date on a specific site
export async function getWorkersLeft(req, res, next) {
  try {
    const { siteId } = req.params;
    const { tradeName, date } = req.query;
    if (!tradeName || !date)
      return res.status(400).json({ message: 'tradeName and date are required' });

    const site = await Site.findById(siteId).select('tradesNeeded').lean();
    if (!site) return res.status(404).json({ message: 'Site not found' });

    const tradeEntry    = site.tradesNeeded?.find((t) => t.name === tradeName);
    const workersNeeded = tradeEntry?.workers_no ?? 0;

    // workers_no IS the remaining slots — it's decremented on approval, not on pending request.
    // Return it directly so the search bar only reflects approved bookings.
    res.json({ workersNeeded, workersOffered: 0, workersLeft: workersNeeded, isFull: workersNeeded <= 0 });
  } catch (err) {
    next(err);
  }
}

// POST /api/contractor/trade-pros/:tradeId/ask-availability
// Sends an availability-request email to the trade professional
export async function askAvailability(req, res, next) {
  try {
    const { date, siteName, siteAddress = '', lang = 'en', siteId,
            tradeName = '' } = req.body;
    const workersOffered = 1; // contractor never sets workers — trade pro determines this
    if (!date) return res.status(400).json({ message: 'date is required' });

    // ── Check worker slots before doing anything else ─────────────────────
    // workers_no is decremented on approval, so it's the authoritative remaining count.
    if (siteId && tradeName) {
      const site = await Site.findById(siteId).select('tradesNeeded').lean();
      const tradeEntry    = site?.tradesNeeded?.find((t) => t.name === tradeName);
      const workersNeeded = tradeEntry?.workers_no ?? 0;

      if (workersNeeded <= 0 && tradeEntry) {
        return res.status(409).json({ slotsFull: true, message: 'All worker slots are filled for this trade and date.' });
      }
    }

    const pro = await TradePro.findById(req.params.tradeId).select('fullName email professionality photo');
    if (!pro) return res.status(404).json({ message: 'Trade professional not found' });

    // Duplicate check — same contractor + trade pro + site + date
    if (siteId) {
      const existing = await Message.findOne({
        tradePro:      req.params.tradeId,
        contractor:    req.userId,
        site:          siteId,
        requestedDate: date,
      });
      if (existing) {
        return res.status(409).json({
          duplicate: true,
          proName:          pro.fullName,
          proProfessionality: pro.professionality,
          proPhoto:         pro.photo || null,
        });
      }
    }

    // Create message record + increment counter
    if (siteId) {
      await Message.create({
        tradePro:       req.params.tradeId,
        site:           siteId,
        contractor:     req.userId,
        requestedDate:  date,
        tradeName,
        workersOffered: 1,
        status:         'pending',
        type:           'availability',
        senderType:     'contractor',
      });
    }
    await TradePro.findByIdAndUpdate(req.params.tradeId, {
      $inc: { availabilityMessages: 1 },
    });

    console.log(`[askAvailability] ✓ Email sent to ${pro.email} for date ${date}`);
    res.json({ message: 'Availability request sent successfully.' });
  } catch (err) {
    console.error('[askAvailability] ERROR:', err.message);
    next(err);
  }
}

// GET /api/contractor/notifications
// Returns approved availability messages for this contractor (status is the only truth)
export async function getNotifications(req, res, next) {
  try {
    // Only show availability requests the contractor sent that were approved by the trade pro
    // (senderType:'contractor' + type:'availability' + status:'approved' = trade pro clicked the email link)
    const notifications = await Message.find({
      contractor:  req.userId,
      type:        'availability',
      senderType:  'contractor',
      status:      'approved',
    })
      .populate('tradePro', 'fullName professionality photo')
      .populate('site',     'name')
      .sort({ updatedAt: -1 })
      .lean();
    res.json({ notifications });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/contractor/notifications/read  (kept for API compatibility, no-op)
export async function markNotificationsRead(req, res, next) {
  res.json({ ok: true });
}

// GET /api/contractor/sites/:id/work-plan
// Returns all trade pros booked to this site (primary: tradepros.bookings.siteId query;
// augmented with slot details from site.tradesNeeded for date/budget).
export async function getWorkPlan(req, res, next) {
  try {
    const siteId = req.params.id;

    const [site, bookedPros] = await Promise.all([
      Site.findOne({ _id: siteId, contractor: req.userId })
        .select('name tradesNeeded')
        .lean(),
      TradePro.find({ 'bookings.siteId': siteId })
        .select('fullName professionality hourlyRate bookings')
        .lean(),
    ]);

    if (!site) return res.status(404).json({ message: 'Site not found' });

    // Map tradeProId → assigned slot for date + budget lookup
    const slotByProId = {};
    for (const slot of site.tradesNeeded ?? []) {
      if (slot.tradeProId) slotByProId[String(slot.tradeProId)] = slot;
    }

    const rows = bookedPros.map(pro => {
      const slot       = slotByProId[String(pro._id)];
      const booking    = pro.bookings.find(b => String(b.siteId) === String(siteId));
      // Use booking values first — they are snapshotted at approval time and are authoritative.
      // slot.workers_no can be 0 (decremented as workers are assigned) so must not be used as primary.
      const totalHours = booking?.totalHours ?? slot?.totalHours ?? null;
      const workersNo  = booking?.workers_no || slot?.workers_no || 1;
      const rate       = pro.hourlyRate ?? null;
      const total      = (totalHours && rate) ? parseFloat((workersNo * totalHours * rate).toFixed(2)) : null;

      return {
        professionality: pro.professionality,
        tradeName:       pro.fullName,
        tradeProId:      String(pro._id),
        date:            slot?.requiredDate ?? booking?.dates?.[0] ?? '—',
        workers_no:      workersNo,
        totalHours,
        hourlyRate:      rate,
        budgetTotal:     total,   // workers_no × totalHours × hourlyRate
      };
    });

    res.json({ siteName: site.name, rows });
  } catch (err) {
    next(err);
  }
}

// POST /api/contractor/sites/:id/work-plan/request-date
// Checks trade pro availability for a new date, then sends an availability request (same as askAvailability)
export async function requestWorkPlanDate(req, res, next) {
  try {
    const { tradeName, requiredDate, lang = 'en' } = req.body;
    if (!tradeName || !requiredDate) return res.status(400).json({ message: 'tradeName and requiredDate are required' });

    const site = await Site.findOne({ _id: req.params.id, contractor: req.userId })
      .select('name address tradesNeeded')
      .lean();
    if (!site) return res.status(404).json({ message: 'Site not found' });

    const tradeEntry = site.tradesNeeded?.find(t => t.name?.toLowerCase() === tradeName.toLowerCase());
    if (!tradeEntry?.tradeProId) return res.status(400).json({ message: 'No trade pro assigned to this trade' });

    const pro = await TradePro.findById(tradeEntry.tradeProId)
      .select('fullName email professionality photo busyDays bookings')
      .lean();
    if (!pro) return res.status(404).json({ message: 'Trade professional not found' });

    // ── Availability check ─────────────────────────────────────────────────────
    const isBusy   = pro.busyDays?.includes(requiredDate);
    const isBooked = pro.bookings?.some(b =>
      b.dates?.includes(requiredDate) && (b.status === 'booked' || b.status === 'order')
    );
    if (isBusy || isBooked) {
      return res.status(409).json({ notAvailable: true, tradeName: pro.fullName });
    }

    // ── Send availability request — same logic as askAvailability ──────────────
    const contractor = await Contractor.findById(req.userId).select('companyName').lean();
    const companyName = contractor?.companyName || 'Your contractor';

    const locale      = lang === 'es' ? 'es-ES' : 'en-US';
    const displayDate = new Date(requiredDate + 'T12:00:00').toLocaleDateString(locale, {
      year: 'numeric', month: 'long', day: 'numeric',
    });

    await Message.create({
      tradePro:      pro._id,
      site:          site._id || req.params.id,
      contractor:    req.userId,
      requestedDate: requiredDate,
      status:        'pending',
      type:          'availability',
      senderType:    'contractor',
    });
    await TradePro.findByIdAndUpdate(pro._id, { $inc: { availabilityMessages: 1 } });

    res.json({ ok: true, tradeName: pro.fullName });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/contractor/sites/:id/work-plan  — update requiredDate for a trade
export async function updateWorkPlanDate(req, res, next) {
  try {
    const { tradeName, requiredDate } = req.body;
    if (!tradeName) return res.status(400).json({ message: 'tradeName required' });
    const result = await Site.updateOne(
      { _id: req.params.id, contractor: req.userId, 'tradesNeeded.name': tradeName },
      { $set: { 'tradesNeeded.$.requiredDate': requiredDate ?? null } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ message: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/contractor/sites/:id/work-plan  — unassign a trade (reset assigned + tradeProId)
export async function deleteWorkPlanTrade(req, res, next) {
  try {
    const { tradeName } = req.body;
    if (!tradeName) return res.status(400).json({ message: 'tradeName required' });
    const result = await Site.updateOne(
      { _id: req.params.id, contractor: req.userId, 'tradesNeeded.name': tradeName },
      { $set: { 'tradesNeeded.$.assigned': false, 'tradesNeeded.$.tradeProId': null } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ message: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// GET /api/contractor/applications
// Everything now lives in the messages collection — applications are type:'application',
// reschedule requests are type:'reschedule'. No separate Application model needed.
export async function getApplications(req, res, next) {
  try {
    // Load all applications (trade-side requests) for this contractor's sites
    const applications = await Message.find({
      contractor: req.userId,
      type:       'application',
    })
      .populate('tradePro', 'fullName professionality photo hourlyRate')
      .populate('site',     'name address type photo tradesNeeded')
      .sort({ createdAt: -1 })
      .lean();

    // Build a Set of "tradeProId:date" for already-approved trades
    const approvedMsgs = await Message.find({
      contractor: req.userId,
      status:     'approved',
      type:       'approval',
    }).select('tradePro requestedDate').lean();

    const bookedKeys = new Set(
      approvedMsgs
        .filter(m => m.tradePro && m.requestedDate)
        .map(m => `${String(m.tradePro)}:${m.requestedDate}`)
    );

    // Flag pending applications where that trade pro is already booked on that date
    const marked = applications.map(app => {
      if (app.status === 'accepted') return app;
      const key = `${String(app.tradePro?._id)}:${app.requestedDate || ''}`;
      return bookedKeys.has(key) ? { ...app, _alreadyBooked: true } : app;
    });

    // Reschedule requests sent by trade pros
    const rescheduleRequests = await Message.find({
      contractor: req.userId,
      status:     'pending',
      type:       'reschedule',
    })
      .populate('tradePro', 'fullName professionality photo hourlyRate')
      .populate('site',     'name address type photo tradesNeeded')
      .sort({ createdAt: -1 })
      .lean();

    const reschedules = rescheduleRequests.map(m => ({ ...m, _isReschedule: true }));

    // Pending worker_offer messages from trade pros awaiting contractor approval
    const workerOffers = await Message.find({
      contractor: req.userId,
      type:       'worker_offer',
      status:     'pending',
    })
      .populate('tradePro', 'fullName professionality photo hourlyRate')
      .populate('site',     'name address type photo tradesNeeded')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ applications: marked, reschedules, sentRequests: [], workerOffers });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/contractor/messages/:id/approve-worker-offer
// Contractor approves the trade pro's worker count → decrements workers_no on site
export async function approveWorkerOffer(req, res, next) {
  try {
    const msg = await Message.findOne({
      _id:        req.params.id,
      contractor: req.userId,
      type:       'worker_offer',
      status:     'pending',
    })
      .populate('tradePro', 'professionality fullName hourlyRate')
      .populate('site',     'name address tradesNeeded contractor');

    if (!msg) return res.status(404).json({ message: 'Worker offer not found' });

    const tradeSlot = msg.site?.tradesNeeded?.find(
      (t) => t.name?.toLowerCase() === (msg.tradeName || msg.tradePro?.professionality || '').toLowerCase()
    );

    const workersOffered     = msg.workersOffered ?? 1;
    const currentWorkers     = tradeSlot?.workers_no ?? 0;
    const newWorkersCount    = Math.max(0, currentWorkers - workersOffered);
    const totalHours         = tradeSlot?.totalHours ?? null;
    const hourlyRate         = msg.tradePro?.hourlyRate ?? null;
    const newTotalWorkingHrs = (tradeSlot?.budgetType === 'hours' && totalHours)
      ? totalHours * newWorkersCount : null;

    const minDeposit = (hourlyRate && totalHours)
      ? parseFloat((workersOffered * hourlyRate * totalHours).toFixed(2))
      : null;

    // Mark message approved + set min_deposit
    msg.status      = 'approved';
    msg.min_deposit = minDeposit;
    await msg.save();

    // Decrement workers_no on the site trade slot
    const professionality = msg.tradePro?.professionality || msg.tradeName;

    console.log(`[approveWorkerOffer] trade="${professionality}" workersOffered=${workersOffered} slots: ${currentWorkers}→${newWorkersCount}`);
    console.log(`[approveWorkerOffer] msg.requestedDate="${msg.requestedDate}" tradeSlot.requiredDate="${tradeSlot?.requiredDate}"`);

    if (professionality && msg.site?._id) {
      // Preserve the existing date if the worker_offer message has no date
      const resolvedDate = msg.requestedDate || tradeSlot?.requiredDate || null;
      console.log(`[approveWorkerOffer] resolvedDate="${resolvedDate}"`);

      const siteSet = {
        'tradesNeeded.$.assigned':   true,
        'tradesNeeded.$.tradeProId': msg.tradePro._id,
        'tradesNeeded.$.workers_no': newWorkersCount,
      };
      if (resolvedDate) siteSet['tradesNeeded.$.requiredDate'] = resolvedDate;
      if (newTotalWorkingHrs !== null) siteSet['tradesNeeded.$.totalWorkingHrs'] = newTotalWorkingHrs;

      console.log('[approveWorkerOffer] siteSet:', JSON.stringify(siteSet));

      const updateResult = await Site.updateOne(
        {
          _id: msg.site._id,
          'tradesNeeded.name': { $regex: new RegExp(`^${professionality}$`, 'i') },
        },
        { $set: siteSet }
      );
      console.log(`[approveWorkerOffer] Site.updateOne matched=${updateResult.matchedCount} modified=${updateResult.modifiedCount}`);
    }

    res.json({ ok: true, slotsRemaining: newWorkersCount, siteId: String(msg.site._id) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/contractor/messages/:id/approve-reschedule
// Contractor approves a trade pro's reschedule request → update requiredDate + swap booking date
export async function approveReschedule(req, res, next) {
  try {
    const msg = await Message.findOne({
      _id:        req.params.id,
      contractor: req.userId,
      status:     'pending',
      type:       'reschedule',
    }).populate('tradePro', 'fullName professionality');
    if (!msg) return res.status(404).json({ message: 'Request not found' });

    const newDate = msg.requestedDate;
    const siteId  = msg.site;

    // 1. Update site's requiredDate for this trade
    await Site.updateOne(
      { _id: siteId, 'tradesNeeded.name': { $regex: new RegExp(`^${msg.tradePro.professionality}$`, 'i') } },
      { $set: { 'tradesNeeded.$.requiredDate': newDate } }
    );

    // 2. Swap the booking date on the trade pro:
    //    Remove the old booking for this site, then push a fresh one with the new date
    const pro = await TradePro.findOne({ _id: msg.tradePro._id, 'bookings.siteId': siteId })
      .select('bookings').lean();
    const oldBooking = pro?.bookings?.find(b => String(b.siteId) === String(siteId));

    if (oldBooking) {
      await TradePro.updateOne(
        { _id: msg.tradePro._id },
        { $pull: { bookings: { siteId: siteId } } }
      );
      await TradePro.updateOne(
        { _id: msg.tradePro._id },
        { $push: { bookings: {
          siteId:      oldBooking.siteId,
          siteName:    oldBooking.siteName,
          siteAddress: oldBooking.siteAddress,
          dates:       [newDate],
          status:      'booked',
        }}}
      );
    }

    // 3. Mark message as approved
    msg.status = 'approved';
    await msg.save();

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/contractor/messages/:id/decline-reschedule
// Contractor declines a trade pro's reschedule request → delete the message
export async function declineReschedule(req, res, next) {
  try {
    await Message.deleteOne({ _id: req.params.id, contractor: req.userId, status: 'pending', type: 'reschedule' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/contractor/applications/:id/approve
export async function approveApplication(req, res, next) {
  try {
    const { scheduledDate } = req.body; // YYYY-MM-DD

    // Application is now stored as a Message with type:'application'
    const app = await Message.findOne({ _id: req.params.id, type: 'application' })
      .populate('tradePro', 'professionality fullName email hourlyRate')
      .populate('site',     'name address tradesNeeded contractor');
    if (!app) return res.status(404).json({ message: 'Application not found' });

    if (String(app.site.contractor) !== String(req.userId))
      return res.status(403).json({ message: 'Not authorized' });

    if (app.status === 'accepted') return res.json({ message: 'Already approved' });

    // Block if this trade slot is already filled by a different pro
    const tradeSlot = app.site.tradesNeeded?.find(
      (t) => t.name?.toLowerCase() === app.tradePro.professionality?.toLowerCase()
    );
    if (tradeSlot?.assigned) {
      return res.status(409).json({ alreadyAssigned: true, message: 'Trade already assigned for this job' });
    }

    app.status = 'accepted';
    if (scheduledDate) app.requestedDate = scheduledDate;
    await app.save();

    const finalDate = app.requestedDate || scheduledDate || null;

    // ── Decrement workers_no (same logic as approveAvailabilityRequest) ────────
    const workersOffered     = app.workersOffered ?? 1;
    const currentWorkers     = tradeSlot?.workers_no ?? 0;
    const newWorkersCount    = Math.max(0, currentWorkers - workersOffered);
    const totalHours         = tradeSlot?.totalHours ?? null;
    const newTotalWorkingHrs = (tradeSlot?.budgetType === 'hours' && totalHours)
      ? totalHours * newWorkersCount
      : null;

    const siteUpdate = {
      'tradesNeeded.$.tradeProId': app.tradePro._id,
      'tradesNeeded.$.workers_no': newWorkersCount,
      'tradesNeeded.$.assigned':   newWorkersCount <= 0,
    };
    if (newTotalWorkingHrs !== null) siteUpdate['tradesNeeded.$.totalWorkingHrs'] = newTotalWorkingHrs;
    const appResolvedDate = finalDate || tradeSlot?.requiredDate || null;
    if (appResolvedDate) siteUpdate['tradesNeeded.$.requiredDate'] = appResolvedDate;

    // Mark the matching trade slot + decrement remaining worker slots
    await Site.updateOne(
      {
        _id: app.site._id,
        'tradesNeeded.name': { $regex: new RegExp(`^${app.tradePro.professionality}$`, 'i') },
      },
      { $set: siteUpdate }
    );

    // Upgrade the 'order' booking to 'booked' (turns calendar from orange → dark red)
    await TradePro.updateOne(
      { _id: app.tradePro._id, 'bookings.siteId': app.site._id, 'bookings.status': 'order' },
      { $set: { 'bookings.$.status': 'booked' } }
    );

    // Get contractor name for the notification
    const contractor = await Contractor.findById(req.userId).select('companyName');
    const companyName = contractor?.companyName || 'Your contractor';

    // Create in-app approval message for the trade pro
    const approvalWorkers = app.workersOffered ?? 1;
    const approvalRate    = app.tradePro.hourlyRate ?? null;
    const approvalHours   = tradeSlot?.totalHours ?? null;
    const minDeposit = (approvalRate && approvalHours)
      ? parseFloat((approvalWorkers * approvalRate * approvalHours).toFixed(2))
      : null;

    await Message.create({
      tradePro:       app.tradePro._id,
      site:           app.site._id,
      contractor:     req.userId,
      requestedDate:  finalDate || '',
      tradeName:      app.tradePro.professionality || '',
      workersOffered: approvalWorkers,
      min_deposit:    minDeposit,
      status:         'approved',
      type:           'approval',
      senderType:     'contractor',
    });
    await TradePro.findByIdAndUpdate(app.tradePro._id, { $inc: { availabilityMessages: 1 } });

    // Check messages collection: find any other pending applications from the
    // same trade pro on the same date so the client can gray them out immediately
    const siblingApplicationIds = finalDate
      ? await Message.find({
          type:    'application',
          site:    { $in: await Site.find({ contractor: req.userId }).distinct('_id') },
          tradePro: app.tradePro._id,
          status:   'pending',
        }).distinct('_id')
      : [];

    res.json({
      ok:                  true,
      blockedTradeProId:   String(app.tradePro._id),
      blockedDate:         finalDate || null,
      blockedApplicationIds: siblingApplicationIds.map(String),
      slotsRemaining:      newWorkersCount,
      siteId:              String(app.site._id),
    });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/contractor/messages/:id/approve-availability
// Contractor directly approves a sent availability request (books the trade pro without waiting for their response)
export async function approveAvailabilityRequest(req, res, next) {
  try {
    const msg = await Message.findOne({
      _id:        req.params.id,
      contractor: req.userId,
      type:       'availability',
      status:     'pending',
    })
      .populate('tradePro', 'professionality fullName email hourlyRate')
      .populate('site',     'name address tradesNeeded contractor');

    if (!msg) return res.status(404).json({ message: 'Request not found' });
    if (String(msg.site.contractor) !== String(req.userId))
      return res.status(403).json({ message: 'Not authorized' });

    // Block if the trade slot is already assigned to another pro
    const tradeSlot = msg.site.tradesNeeded?.find(
      (t) => t.name?.toLowerCase() === msg.tradePro.professionality?.toLowerCase()
    );
    if (tradeSlot?.assigned && (tradeSlot.workers_no ?? 1) <= 0) {
      return res.status(409).json({ alreadyAssigned: true, message: 'Trade already assigned for this job' });
    }

    const finalDate = msg.requestedDate || null;

    // Calculate remaining workers (and total hrs) after this booking
    const workersOffered     = msg.workersOffered ?? 1;
    const currentWorkers     = tradeSlot?.workers_no ?? 0;
    const newWorkersCount    = Math.max(0, currentWorkers - workersOffered);
    const totalHours         = tradeSlot?.totalHours ?? null;
    const newTotalWorkingHrs = (tradeSlot?.budgetType === 'hours' && totalHours)
      ? totalHours * newWorkersCount
      : null;

    // 1. Mark this availability message as accepted
    msg.status = 'accepted';
    await msg.save();

    // 2. Update trade slot: decrement workers_no; mark assigned when fully filled
    const avReqSlotSet = {
      'tradesNeeded.$.assigned':       true,
      'tradesNeeded.$.tradeProId':     msg.tradePro._id,
      'tradesNeeded.$.workers_no':     newWorkersCount,
      'tradesNeeded.$.totalWorkingHrs': newTotalWorkingHrs,
    };
    const avReqResolvedDate = finalDate || tradeSlot?.requiredDate || null;
    if (avReqResolvedDate) avReqSlotSet['tradesNeeded.$.requiredDate'] = avReqResolvedDate;

    await Site.updateOne(
      {
        _id: msg.site._id,
        'tradesNeeded.name': { $regex: new RegExp(`^${msg.tradePro.professionality}$`, 'i') },
      },
      { $set: avReqSlotSet }
    );

    // 3. Push booking onto trade pro (as 'booked')
    //    totalHours = minimum job hours (for clock validation)
    //    workers_no = how many workers this specific trade pro is bringing
    if (finalDate) {
      await TradePro.updateOne(
        { _id: msg.tradePro._id },
        { $push: { bookings: {
          siteId:      msg.site._id,
          siteName:    msg.site.name,
          siteAddress: msg.site.address,
          dates:       [finalDate],
          status:      'booked',
          totalHours:  tradeSlot?.totalHours   ?? null,
          workers_no:  workersOffered,                    // workers THIS trade pro brings
        }}}
      );
    }

    // 4. Create in-app approval message for the trade pro
    const avReqWorkers  = msg.workersOffered ?? 1;
    const avReqRate     = msg.tradePro.hourlyRate ?? null;
    const avReqHours    = tradeSlot?.totalHours ?? null;
    const avReqDeposit  = (avReqRate && avReqHours)
      ? parseFloat((avReqWorkers * avReqRate * avReqHours).toFixed(2))
      : null;

    await Message.create({
      tradePro:       msg.tradePro._id,
      site:           msg.site._id,
      contractor:     req.userId,
      requestedDate:  finalDate || '',
      workersOffered: avReqWorkers,
      min_deposit:    avReqDeposit,
      status:         'approved',
      type:           'approval',
      senderType:     'contractor',
    });
    await TradePro.findByIdAndUpdate(msg.tradePro._id, { $inc: { availabilityMessages: 1 } });

    res.json({ ok: true, slotsRemaining: newWorkersCount, siteId: String(msg.site._id) });
  } catch (err) {
    next(err);
  }
}

// GET /api/contractor/sites/:siteId/deposit-summary
export async function getSiteDepositSummary(req, res, next) {
  try {
    const { siteId } = req.params;
    console.log(`\n[depositSummary] ── siteId=${siteId} contractorId=${req.userId}`);

    // If deposit already initiated for this site, return empty (no need to re-prompt)
    const alreadyInitiated = await Message.findOne({
      site:       siteId,
      contractor: req.userId,
      stripeDepositIntentId: { $ne: null },
    }).lean();
    if (alreadyInitiated) {
      console.log(`[depositSummary] already initiated — stripeDepositIntentId=${alreadyInitiated.stripeDepositIntentId}`);
      return res.json({ rows: [], total: 0, siteName: '', alreadyPaid: true });
    }
    console.log(`[depositSummary] no prior deposit found — querying approved messages`);

    // Include both direct application approvals AND worker_offer approvals
    const messages = await Message.find({
      site:       siteId,
      contractor: req.userId,
      type:       { $in: ['approval', 'worker_offer'] },
      status:     'approved',
    })
      .populate('tradePro', 'fullName professionality hourlyRate')
      .populate('site', 'name tradesNeeded')
      .lean();

    console.log(`[depositSummary] messages found: ${messages.length}`);
    messages.forEach((m, i) => {
      console.log(`  [${i}] type=${m.type} status=${m.status} tradeName=${m.tradeName} workersOffered=${m.workersOffered} min_deposit=${m.min_deposit} hourlyRate=${m.tradePro?.hourlyRate}`);
    });

    const rows = messages.map((msg) => {
      const tradeSlot = msg.site?.tradesNeeded?.find(
        (t) => t.name?.toLowerCase() === (msg.tradeName || msg.tradePro?.professionality || '').toLowerCase()
      );
      const workers = msg.workersOffered ?? 1;
      const rate    = msg.tradePro?.hourlyRate ?? null;
      const hours   = tradeSlot?.totalHours ?? null;
      const deposit = msg.min_deposit ??
        (rate && hours ? parseFloat((workers * rate * hours).toFixed(2)) : null);

      console.log(`  row: tradeName=${msg.tradeName} workers=${workers} rate=${rate} hours=${hours} tradeSlot=${JSON.stringify(tradeSlot?.name)} deposit=${deposit}`);

      return {
        messageId:       String(msg._id),
        tradeName:       msg.tradeName || msg.tradePro?.professionality || '—',
        professionality: msg.tradePro?.professionality || '—',
        tradeProName:    msg.tradePro?.fullName || '—',
        workers,
        hourlyRate:      rate,
        totalHours:      hours,
        min_deposit:     deposit,
      };
    });

    const total = parseFloat(rows.reduce((s, r) => s + (r.min_deposit ?? 0), 0).toFixed(2));
    const siteName = messages[0]?.site?.name || '';
    console.log(`[depositSummary] total=$${total} siteName="${siteName}" → sending response`);

    res.json({ rows, total, siteName });
  } catch (err) {
    next(err);
  }
}

// POST /api/contractor/deposit-confirmed
// Called from client after stripe.confirmPayment succeeds.
// Verifies the PI hold with Stripe, marks depositStatus='held' on the worker_offer message,
// and creates a new type:'payment' status:'deposited' message to record the deposit event.
export async function confirmDeposit(req, res, next) {
  try {
    const { siteId, paymentIntentId } = req.body;
    console.log(`\n[confirmDeposit] siteId=${siteId} piId=${paymentIntentId} contractorId=${req.userId}`);

    if (!siteId || !paymentIntentId) {
      return res.status(400).json({ message: 'siteId and paymentIntentId are required' });
    }

    // Verify with Stripe that the hold is in place
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    console.log(`[confirmDeposit] PI status=${pi.status}`);
    if (!['requires_capture', 'succeeded'].includes(pi.status)) {
      return res.status(400).json({ message: `Unexpected PI status: ${pi.status}` });
    }

    // Find the stamped source message — could be worker_offer OR approval type
    const source = await Message.findOne({
      site:       siteId,
      contractor: req.userId,
      stripeDepositIntentId: paymentIntentId,
      type:       { $in: ['worker_offer', 'approval'] },
    }).lean();

    if (!source) {
      console.log(`[confirmDeposit] ❌ no stamped source message found for PI=${paymentIntentId} site=${siteId}`);
      return res.status(404).json({ message: 'Source message not found — deposit intent may not have been stamped' });
    }
    console.log(`[confirmDeposit] source message _id=${source._id} type=${source.type}`);

    // Mark the worker_offer as held
    await Message.findByIdAndUpdate(source._id, { depositStatus: 'held' });

    // Save payment method for future off-session overage charges (no card modal needed)
    if (pi.payment_method) {
      await Contractor.findByIdAndUpdate(req.userId, { stripeDefaultPaymentMethod: pi.payment_method });
      console.log(`[confirmDeposit] saved PM ${pi.payment_method} on contractor for future off-session charges`);
    }

    // Use Stripe's amount as the authoritative deposit sum (pi.amount is in cents)
    const stripeAmount = pi.amount / 100;

    // Create the deposit record message
    const depositMsg = await Message.create({
      tradePro:      source.tradePro,
      site:          source.site,
      contractor:    source.contractor,
      requestedDate: source.requestedDate,
      tradeName:     source.tradeName,
      workersOffered: source.workersOffered,
      min_deposit:   stripeAmount,
      stripeDepositIntentId: paymentIntentId,
      depositStatus: 'held',
      type:          'payment',
      status:        'deposited',
      senderType:    'contractor',
    });
    console.log(`[confirmDeposit] stripeAmount=$${stripeAmount} stored in deposit message`);

    console.log(`[confirmDeposit] ✅ deposit message created _id=${depositMsg._id}`);
    res.json({ ok: true, messageId: String(depositMsg._id) });
  } catch (err) {
    next(err);
  }
}

// GET /api/contractor/trade-pros/:tradeId/busy-days
// Returns the busy-days calendar for a specific trade professional (read-only)
export async function getTradeBusyDays(req, res, next) {
  try {
    const pro = await TradePro.findById(req.params.tradeId).select('fullName professionality busyDays bookings photo');
    if (!pro) return res.status(404).json({ message: 'Trade professional not found' });
    res.json({ pro });
  } catch (err) {
    next(err);
  }
}

// GET /api/contractor/sites/:id/find-trades?trade=Plumber&distance=25&unit=mi
// Uses MongoDB $geoNear to find nearby trade professionals of the requested type
export async function findTrades(req, res, next) {
  console.log(`[findTrades] HIT  siteId=${req.params.id}  query=${JSON.stringify(req.query)}`);
  try {
    const site = await Site.findOne({ _id: req.params.id, contractor: req.userId });
    if (!site) {
      console.log('[findTrades] Site not found or not owned by this contractor');
      return res.status(404).json({ message: 'Site not found' });
    }

    const { trade, distance = '25', unit = 'mi', maxRate, minRating } = req.query;
    if (!trade) return res.status(400).json({ message: 'trade query param is required' });
    const minGrade = minRating ? parseInt(minRating, 10) : 0;

    // Pull the requiredDate for this trade from the site
    const tradeEntry  = site.tradesNeeded.find((t) => t.name === trade);
    const requiredDate = tradeEntry?.requiredDate ?? null;

    let [lng, lat] = site.location.coordinates;

    // Site was created before geocoding was added — geocode now and persist
    if (lng === 0 && lat === 0) {
      const coords = await geocodeAddress(site.address);
      if (!coords) {
        return res.status(422).json({ message: 'Site location could not be determined from its address.' });
      }
      lng = coords.lng;
      lat = coords.lat;
      await Site.findByIdAndUpdate(site._id, {
        location: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
      });
    }

    const meters = unit === 'km'
      ? parseFloat(distance) * 1000
      : parseFloat(distance) * 1609.344;

    const radiusKm = (meters / 1000).toFixed(1);
    const radiusMi = (meters / 1609.344).toFixed(1);
    console.log(
      `\n[findTrades] Site: "${site.name}" (${site.address})\n` +
      `             Location : lat=${lat.toFixed(6)}, lng=${lng.toFixed(6)}\n` +
      `             Trade    : ${trade}\n` +
      `             Radius   : ${radiusMi} mi / ${radiusKm} km (${Math.round(meters)} m)`
    );

    // Today's date key for availability sort
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // Haversine distance (meters) computed purely from stored coordinates.
    // Uses no geo index — works regardless of BSON type or index state.
    const haversineExpr = {
      $let: {
        vars: {
          dLat: { $degreesToRadians: { $subtract: [lat, { $arrayElemAt: ['$location.coordinates', 1] }] } },
          dLng: { $degreesToRadians: { $subtract: [lng, { $arrayElemAt: ['$location.coordinates', 0] }] } },
          lat1: { $degreesToRadians: { $arrayElemAt: ['$location.coordinates', 1] } },
          lat2: { $degreesToRadians: lat },
        },
        in: {
          $multiply: [
            2 * 6371000,
            { $asin: {
              $sqrt: {
                $add: [
                  { $pow: [{ $sin: { $divide: ['$$dLat', 2] } }, 2] },
                  { $multiply: [
                    { $cos: '$$lat1' },
                    { $cos: '$$lat2' },
                    { $pow: [{ $sin: { $divide: ['$$dLng', 2] } }, 2] },
                  ]},
                ],
              },
            }},
          ],
        },
      },
    };

    const pipeline = [
      // 1. Profession filter — uses the professionality index
      { $match: { professionality: trade } },
      // 2. Compute Haversine distance from the site to each trade's stored coordinates
      { $addFields: { distance: haversineExpr } },
      // 3. Keep only trades within the requested radius
      { $match: { distance: { $lte: meters } } },
    ];

    // Optional rate ceiling — include pros with no rate set
    if (maxRate) {
      pipeline.push({
        $match: {
          $or: [
            { hourlyRate: { $lte: parseFloat(maxRate) } },
            { hourlyRate: null },
            { hourlyRate: { $exists: false } },
          ],
        },
      });
    }

    // Optional minimum grade filter — graded trades must meet the minimum;
    // ungraded trades (avgGrade: null) are always included regardless of the filter.
    if (minGrade > 0) {
      pipeline.push({
        $match: {
          $or: [
            { avgGrade: { $gte: minGrade } },
            { avgGrade: null },
            { avgGrade: { $exists: false } },
          ],
        },
      });
    }

    // ── HARD FILTER: exclude trades already booked on the requiredDate ────────
    // A trade is "booked" when an approval pushed their date into bookings[].dates.
    // Also exclude trades who manually marked that day as busy (busyDays).
    if (requiredDate) {
      pipeline.push({
        $match: {
          // must NOT have requiredDate in any booking's dates array
          'bookings.dates': { $nin: [requiredDate] },
          // must NOT have requiredDate in their personal busyDays
          busyDays: { $nin: [requiredDate] },
        },
      });
    }

    // Sort: available on requiredDate (or today) first, then by hourlyRate
    const sortDateKey = requiredDate || todayKey;
    pipeline.push(
      {
        $addFields: {
          isAvailableOnDate: {
            $not: [{ $in: [sortDateKey, { $ifNull: ['$busyDays', []] }] }],
          },
        },
      },
      // When a min grade is set: sort by avgGrade desc first, then availability
      // Otherwise: keep availability-first, then hourlyRate
      minGrade > 0
        ? { $sort: { avgGrade: -1, isAvailableOnDate: -1, hourlyRate: 1 } }
        : { $sort: { isAvailableOnDate: -1, hourlyRate: 1 } },
      {
        $project: {
          fullName:        1,
          phone:           1,
          address:         1,
          professionality: 1,
          photo:           1,
          hourlyRate:      1,
          avgGrade:        1,
          gradeCount:      1,
          busyDays:        1,
          bookings:        1,
          distance:        1,
          location:        1,
        },
      },
      { $limit: 50 },
    );

    const results = await TradePro.aggregate(pipeline);

    if (results.length === 0) {
      console.log(`[findTrades] No ${trade} professionals found within radius.`);
    } else {
      console.log(`[findTrades] Found ${results.length} result(s):`);
      results.forEach((pro, i) => {
        const [proLng, proLat] = pro.location?.coordinates ?? [0, 0];
        const distKm = (pro.distance / 1000).toFixed(2);
        const distMi = (pro.distance / 1609.344).toFixed(2);
        console.log(
          `  ${i + 1}. ${pro.fullName} | lat=${proLat.toFixed(6)}, lng=${proLng.toFixed(6)} | ` +
          `${distMi} mi / ${distKm} km from site`
        );
      });
    }
    console.log('');

    // Strip location from response (internal use only)
    const sanitised = results.map(({ location: _loc, ...rest }) => rest);
    // Sort by avgGrade descending — 5-star pros appear first
    sanitised.sort((a, b) => (b.avgGrade ?? 0) - (a.avgGrade ?? 0));
    res.json({ results: sanitised, total: sanitised.length, requiredDate });
  } catch (err) {
    next(err);
  }
}

// ── Payment Approvals ────────────────────────────────────────────────────────
// tradehours_orders is APPROVED-ONLY. Pending requests arrive as payment_pending
// Messages. On approve: create WorkHoursOrder (approved) + payment_approved msg
// + delete the pending msg. On reject: create payment_rejected msg + delete pending.

// GET /api/contractor/payment-approvals/count
// Badge count — payment messages with status 'pending' awaiting contractor action.
export async function getPaymentApprovalsCount(req, res, next) {
  try {
    const pendingCount = await Message.countDocuments({
      contractor: req.userId,
      type:       'payment',
      status:     'pending',
    });
    res.json({ pendingCount });
  } catch (err) {
    next(err);
  }
}

// GET /api/contractor/payment-approvals
// Returns pending payment messages shaped to look like order objects so the
// existing UI (PaymentApprovalsPage) works without changes.
export async function getPaymentApprovals(req, res, next) {
  try {
    const msgs = await Message.find({ contractor: req.userId, type: 'payment', status: 'pending' })
      .populate('tradePro', 'fullName professionality photo hourlyRate')
      .populate('site',     'name address tradesNeeded')   // ← include tradesNeeded for min hours
      .sort({ createdAt: -1 })
      .lean();

    const orders = msgs.map((m) => {
      const snap = (() => { try { return JSON.parse(m.text || '{}'); } catch { return {}; } })();

      const liveRate  = m.tradePro?.hourlyRate ?? snap.hourly_rate ?? null;
      const actual    = snap.actual_hours ?? 0;
      const workersNo = snap.workers_no   ?? 1;

      // ── Enforce minimum hours from site's tradesNeeded ──────────────────────
      const professionality = m.tradePro?.professionality;
      const siteEntry = professionality
        ? m.site?.tradesNeeded?.find(t => t.name?.toLowerCase() === professionality.toLowerCase())
        : null;
      const minHours    = (siteEntry?.budgetType === 'hours' && siteEntry?.totalHours > 0)
        ? siteEntry.totalHours : 0;
      // Use what the trade pro submitted in their work log (snap.workers_no), NOT the site's
      // remaining slots (siteEntry.workers_no) which drops to 0 after everyone is approved.
      const effectiveWorkers = workersNo;  // snap.workers_no ?? 1
      const effective        = minHours > 0 ? Math.max(actual, minHours) : actual;
      const orderSum         = liveRate ? parseFloat((effective * liveRate * effectiveWorkers).toFixed(2)) : 0;

      return {
        _id:          m._id,
        trade_id:     m.tradePro,
        site_id:      { _id: m.site?._id, name: m.site?.name, address: m.site?.address },
        date:         m.requestedDate,
        actual_hours: effective,         // min-enforced billing hours
        submitted_hours: actual,         // what the trade pro actually submitted
        min_hours:    minHours,          // minimum from site (0 if not set)
        hourly_rate:  liveRate,
        workers_no:   effectiveWorkers,  // workers the trade pro submitted in work log
        order_sum:    orderSum,
        status:       'pending',
        createdAt:    m.createdAt,
      };
    });

    res.json({ orders });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/contractor/payment-approvals/:orderId
// Body: { status: 'approved' | 'rejected' }
// orderId is the _id of the pending payment Message (not a WorkHoursOrder).
// On approval : create WorkHoursOrder (approved, amounts locked) + payment msg (approved) + delete pending msg.
// On rejection: create payment msg (rejected, snapshot in text) + delete pending msg.
export async function updatePaymentApproval(req, res, next) {
  try {
    const { orderId } = req.params;
    const { status }  = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'status must be "approved" or "rejected"' });
    }

    // The "order" is actually a pending payment message
    const pendingMsg = await Message.findOne({ _id: orderId, contractor: req.userId, type: 'payment', status: 'pending' })
      .populate('tradePro', 'fullName professionality photo hourlyRate stripeAccountId stripeOnboarded')
      .populate('site',     'name address tradesNeeded')   // ← tradesNeeded for min hours
      .lean();

    if (!pendingMsg) return res.status(404).json({ message: 'Pending request not found' });

    const snap = (() => { try { return JSON.parse(pendingMsg.text || '{}'); } catch { return {}; } })();
    const liveRate = pendingMsg.tradePro?.hourlyRate ?? snap.hourly_rate ?? null;
    const actual   = snap.actual_hours ?? 0;

    // ── Enforce minimum hours + site workers from tradesNeeded ───────────────
    const professionality = pendingMsg.tradePro?.professionality;
    const siteEntry = professionality
      ? pendingMsg.site?.tradesNeeded?.find(t => t.name?.toLowerCase() === professionality.toLowerCase())
      : null;
    const minHours    = (siteEntry?.budgetType === 'hours' && siteEntry?.totalHours > 0)
      ? siteEntry.totalHours : 0;
    // Use snap.workers_no (submitted in work log) — NOT siteEntry.workers_no (remaining slots)
    const effectiveWorkers = snap.workers_no ?? 1;
    const effective        = minHours > 0 ? Math.max(actual, minHours) : actual;
    const lockedSum        = liveRate ? parseFloat((effective * liveRate * effectiveWorkers).toFixed(2)) : 0;

    const tradeId = pendingMsg.tradePro._id ?? pendingMsg.tradePro;
    const siteId  = pendingMsg.site?._id    ?? pendingMsg.site ?? null;

    // ── OVERAGE CHECK (before order creation) ────────────────────────────────
    // Compare lockedSum against what REMAINS in the deposit after prior approvals.
    let overagePiId = req.body.overagePiId ?? null;
    let _depositMsgForCheck = null; // reused below in transfer section
    if (status === 'approved' && lockedSum > 0) {
      _depositMsgForCheck = await Message.findOne({
        site:       siteId,
        contractor: req.userId,
        type:       'payment',
        status:     'deposited',
      }).lean();

      const depositHeld = _depositMsgForCheck?.min_deposit ?? 0;

      // Sum all prior approved orders that drew from this deposit PI
      const priorOrders = await WorkHoursOrder.find({
        site_id:               siteId,
        contractor_id:         req.userId,
        stripePaymentIntentId: _depositMsgForCheck?.stripeDepositIntentId ?? '__none__',
        status:                'approved',
      }).lean();
      const transferredSoFar = priorOrders.reduce((s, o) => s + (o.order_sum || 0), 0);
      const remainingDeposit = Math.max(0, parseFloat((depositHeld - transferredSoFar).toFixed(2)));
      const overageAmt       = parseFloat((Math.max(0, lockedSum - remainingDeposit)).toFixed(2));

      console.log(`[updatePaymentApproval] deposit=$${depositHeld} transferredSoFar=$${transferredSoFar} remaining=$${remainingDeposit} lockedSum=$${lockedSum} overage=$${overageAmt}`);

      if (overageAmt > 0 && !overagePiId) {
        // Try to charge off-session using the contractor's saved payment method (no modal)
        const contractor = await Contractor.findById(req.userId).select('stripeCustomerId stripeDefaultPaymentMethod').lean();
        if (contractor?.stripeDefaultPaymentMethod && contractor?.stripeCustomerId) {
          try {
            const offSessionPi = await stripe.paymentIntents.create({
              amount:           Math.round(overageAmt * 100),
              currency:         'usd',
              customer:         contractor.stripeCustomerId,
              payment_method:   contractor.stripeDefaultPaymentMethod,
              confirm:          true,
              off_session:      true,
              description:      `TradeLink — Work overage for ${pendingMsg.tradePro.professionality}`,
              metadata:         { siteId: String(siteId), contractorId: String(req.userId) },
            });
            overagePiId = offSessionPi.id;
            console.log(`[updatePaymentApproval] ✅ off-session overage charge $${overageAmt} — PI ${overagePiId} status=${offSessionPi.status}`);
          } catch (offErr) {
            // Off-session failed (3DS required, expired card, etc.) — fall back to modal
            console.warn(`[updatePaymentApproval] off-session overage failed: ${offErr.message} — returning 402 for modal`);
            const pi = await stripe.paymentIntents.create({
              amount:                    Math.round(overageAmt * 100),
              currency:                  'usd',
              customer:                  contractor.stripeCustomerId,
              automatic_payment_methods: { enabled: true },
              description:               `TradeLink — Work overage for ${pendingMsg.tradePro.professionality}`,
              metadata:                  { siteId: String(siteId), contractorId: String(req.userId) },
            });
            return res.status(402).json({ needsOverage: true, overageAmount: overageAmt, clientSecret: pi.client_secret, piId: pi.id });
          }
        } else {
          // No saved PM — show modal
          const pi = await stripe.paymentIntents.create({
            amount:                    Math.round(overageAmt * 100),
            currency:                  'usd',
            automatic_payment_methods: { enabled: true },
            description:               `TradeLink — Work overage for ${pendingMsg.tradePro.professionality}`,
            metadata:                  { siteId: String(siteId), contractorId: String(req.userId) },
          });
          return res.status(402).json({ needsOverage: true, overageAmount: overageAmt, clientSecret: pi.client_secret, piId: pi.id });
        }
      }
    }

    // ── REJECTION ────────────────────────────────────────────────────────────
    if (status === 'rejected') {
      await Promise.all([
        Message.create({
          tradePro:      tradeId,
          site:          siteId,
          contractor:    req.userId,
          requestedDate: pendingMsg.requestedDate,
          text:       JSON.stringify({ actual_hours: effective, hourly_rate: liveRate, workers_no: effectiveWorkers, order_sum: lockedSum }),
          status:     'rejected',
          type:       'payment',
          senderType: 'contractor',
        }),
        Message.findByIdAndDelete(orderId),
      ]);
      return res.json({ deleted: true, _id: orderId });
    }

    // ── APPROVAL ─────────────────────────────────────────────────────────────
    // Create the WorkHoursOrder now (first and only time it enters the collection).
    const [newOrder] = await Promise.all([
      WorkHoursOrder.create({
        contractor_id: req.userId,
        trade_id:      tradeId,
        site_id:       siteId,
        date:          pendingMsg.requestedDate,
        actual_hours:  effective,     // min-enforced hours
        hourly_rate:   liveRate,
        workers_no:    effectiveWorkers,  // workers submitted in work log
        order_sum:     lockedSum,
        status:        'approved',
      }),
      Message.create({
        tradePro:      tradeId,
        site:          siteId,
        contractor:    req.userId,
        requestedDate: pendingMsg.requestedDate,
        order_sum:     lockedSum,
        status:        'approved',
        type:          'payment',
        senderType:    'contractor',
      }),
      Message.findByIdAndDelete(orderId),
    ]);

    // ── Stripe: capture deposit hold → transfer to trade pro ─────────────────
    const stripeAccountId = pendingMsg.tradePro?.stripeAccountId ?? null;
    let capturedPiId = null;
    let transferId   = null;

    if (lockedSum > 0) {
      const amountCents = Math.round(lockedSum * 100);

      // Reuse the deposit message already fetched in the overage check (avoid double query)
      const depositMsg = _depositMsgForCheck ?? await Message.findOne({
        site:       siteId,
        contractor: req.userId,
        type:       'payment',
        status:     'deposited',
      }).lean();

      console.log(`[updatePaymentApproval] lockedSum=$${lockedSum} amountCents=${amountCents} depositPI=${depositMsg?.stripeDepositIntentId ?? 'none'}`);

      let sourceChargeId = null; // charge to use as source_transaction for transfer

      if (depositMsg?.stripeDepositIntentId) {
        try {
          const pi = await stripe.paymentIntents.retrieve(depositMsg.stripeDepositIntentId);
          console.log(`[updatePaymentApproval] deposit PI ${pi.id} status=${pi.status} authorizedCents=${pi.amount}`);

          if (pi.status === 'requires_capture') {
            // Capture the full authorized amount so all future approvals on this site
            // can draw from the same charge via source_transaction without hitting
            // the "source already fully transferred" error on the 2nd+ trade pro.
            const captureAmt = pi.amount;
            const captured = await stripe.paymentIntents.capture(pi.id, { amount_to_capture: captureAmt });
            capturedPiId    = captured.id;
            sourceChargeId  = captured.latest_charge ?? null;
            console.log(`[updatePaymentApproval] ✅ captured full $${captureAmt / 100} from PI ${capturedPiId} — chargeId=${sourceChargeId} status=${captured.status}`);
          } else if (pi.status === 'succeeded') {
            capturedPiId   = pi.id;
            sourceChargeId = pi.latest_charge ?? null;
            console.log(`[updatePaymentApproval] PI already captured — chargeId=${sourceChargeId}, using as source_transaction`);
          } else {
            console.log(`[updatePaymentApproval] ⚠️ PI status=${pi.status} — cannot capture`);
          }
        } catch (err) {
          console.error('[updatePaymentApproval] Stripe capture error:', err.message);
        }
      }

      // ── Split transfer: deposit portion + overage portion ────────────────────
      // depositTransfer = what we can draw from the deposit charge (remaining, not full deposit)
      const depositHeldAmt   = depositMsg?.min_deposit ?? 0;
      const priorApproved    = await WorkHoursOrder.find({
        site_id:               siteId,
        contractor_id:         req.userId,
        stripePaymentIntentId: depositMsg?.stripeDepositIntentId ?? '__none__',
        status:                'approved',
        _id:                   { $ne: newOrder._id }, // exclude the just-created order
      }).lean();
      const alreadyTransferred = priorApproved.reduce((s, o) => s + (o.order_sum || 0), 0);
      const remaining          = Math.max(0, depositHeldAmt - alreadyTransferred);
      const depositTransfer    = Math.min(lockedSum, remaining);
      const overageTransfer    = parseFloat((lockedSum - depositTransfer).toFixed(2));

      if (stripeAccountId && depositTransfer > 0 && sourceChargeId) {
        try {
          const transfer = await stripe.transfers.create({
            amount:             Math.round(depositTransfer * 100),
            currency:           'usd',
            destination:        stripeAccountId,
            source_transaction: sourceChargeId,
            description:        `TradeLink — ${pendingMsg.tradePro.professionality} work payment (deposit)`,
            metadata:           { orderId: String(newOrder._id), siteId: String(siteId) },
          });
          transferId = transfer.id;
          console.log(`[updatePaymentApproval] ✅ deposit transfer $${depositTransfer} → ${stripeAccountId} — transfer_id: ${transferId}`);
        } catch (err) {
          console.error('[updatePaymentApproval] Stripe deposit transfer error:', err.message);
        }
      } else if (!stripeAccountId) {
        console.log(`[updatePaymentApproval] ⚠️ no stripeAccountId for trade pro — transfer skipped`);
      }

      // Overage transfer from the extra PI the contractor just paid
      if (stripeAccountId && overageTransfer > 0 && overagePiId) {
        try {
          const overagePI      = await stripe.paymentIntents.retrieve(overagePiId);
          const overageCharge  = overagePI.latest_charge ?? null;
          if (overageCharge) {
            const ovTr = await stripe.transfers.create({
              amount:             Math.round(overageTransfer * 100),
              currency:           'usd',
              destination:        stripeAccountId,
              source_transaction: overageCharge,
              description:        `TradeLink — ${pendingMsg.tradePro.professionality} work payment (overage)`,
              metadata:           { orderId: String(newOrder._id), siteId: String(siteId) },
            });
            console.log(`[updatePaymentApproval] ✅ overage transfer $${overageTransfer} → ${stripeAccountId} — transfer_id: ${ovTr.id}`);
            if (!transferId) transferId = ovTr.id; // fallback if no deposit transfer
          }
        } catch (err) {
          console.error('[updatePaymentApproval] Stripe overage transfer error:', err.message);
        }
      }

      // Store Stripe IDs + payment status on the order
      if (capturedPiId || transferId) {
        await WorkHoursOrder.findByIdAndUpdate(newOrder._id, {
          stripePaymentIntentId: capturedPiId,
          stripeTransferId:      transferId,
          paymentStatus:         transferId ? 'paid' : 'pending',
          payment_sum:           transferId ? lockedSum : null,
        });
      }
    }

    const populated = await WorkHoursOrder.findById(newOrder._id)
      .populate('trade_id', 'fullName professionality photo hourlyRate')
      .populate('site_id',  'name address')
      .lean();

    res.json({ deleted: true, _id: orderId, order: populated });
  } catch (err) {
    next(err);
  }
}

// ── GET /contractor/trade-grades/eligible ────────────────────────────────────
// Returns every approved order for this contractor that hasn't been graded yet.
// Each order is independently gradable — same trade on the same site can appear
// multiple times if they completed multiple orders.
export async function getGradableTrades(req, res, next) {
  try {
    const contractorId = req.userId;

    // All approved orders for this contractor (each row = one gradable opportunity)
    const orders = await WorkHoursOrder.find({ contractor_id: contractorId, status: 'approved' })
      .populate('trade_id', 'fullName professionality photo')
      .populate('site_id',  'name')
      .sort({ createdAt: -1 })
      .lean();

    if (!orders.length) return res.json({ trades: [] });

    // Only keep orders where both trade and site are still populated
    const valid = orders.filter(o => o.trade_id && o.site_id);

    // Remove orders that have already been graded as 'trade' type (keyed by order_id)
    const existing = await TradeGrade.find({ contractor_id: contractorId, grade_type: 'trade' }).select('order_id').lean();
    const gradedOrderIds = new Set(existing.map(g => String(g.order_id)));

    const gradable = valid
      .filter(o => !gradedOrderIds.has(String(o._id)))
      .map(o => ({
        order_id:        o._id,
        order_date:      o.date,          // YYYY-MM-DD string for display
        trade_id:        o.trade_id._id,
        trade_name:      o.trade_id.fullName,
        professionality: o.trade_id.professionality,
        photo:           o.trade_id.photo || null,
        site_id:         o.site_id._id,
        site_name:       o.site_id.name,
      }));

    res.json({ trades: gradable });
  } catch (err) {
    next(err);
  }
}

// ── POST /contractor/trade-grades/photo ──────────────────────────────────────
// Upload a single grade review photo to Cloudinary. Returns { url }.
export async function uploadGradePhoto(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
    const result = await uploadPhoto(req.file.buffer, 'tradelink/grade-photos');
    res.json({ url: result.secure_url });
  } catch (err) {
    next(err);
  }
}

// ── POST /contractor/trade-grades ────────────────────────────────────────────
// Submit a grade (1–5) with optional review text and photo URLs.
export async function submitTradeGrade(req, res, next) {
  try {
    const { trade_id, site_id, order_id, trade_grade, review_text, photos } = req.body;
    const grade = parseInt(trade_grade, 10);
    if (!trade_id || !order_id || isNaN(grade) || grade < 1 || grade > 5) {
      return res.status(400).json({ message: 'trade_id, order_id and trade_grade (1–5) are required.' });
    }

    const photoUrls = Array.isArray(photos) ? photos.filter(u => typeof u === 'string' && u.startsWith('http')) : [];

    const doc = await TradeGrade.findOneAndUpdate(
      { contractor_id: req.userId, order_id },
      {
        trade_id, site_id: site_id || null, order_id,
        grade_type: 'trade',
        trade_grade: grade, grade_name: GRADE_NAMES_MAP[grade],
        review_text: (review_text ?? '').trim(),
        photos: photoUrls,
        date: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Recalculate average and count for this trade across ALL contractors/sites
    const [agg] = await TradeGrade.aggregate([
      { $match: { trade_id: doc.trade_id } },
      { $group: { _id: '$trade_id', avg: { $avg: '$trade_grade' }, count: { $sum: 1 } } },
    ]);

    if (agg) {
      await TradePro.findByIdAndUpdate(trade_id, {
        avgGrade:   Math.round(agg.avg * 10) / 10,  // 1 decimal place, e.g. 4.3
        gradeCount: agg.count,
      });
    }

    res.status(201).json({ grade: doc, avgGrade: agg?.avg ?? grade, gradeCount: agg?.count ?? 1 });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Already graded.' });
    next(err);
  }
}

// ── GET /contractor/trade-grades/:tradeId/reviews ─────────────────────────────
// Returns all reviews (text + photos) for a specific trade pro, newest first.
// Uses the { trade_id: 1, createdAt: -1 } index for fast lookup.
export async function getTradeReviews(req, res, next) {
  try {
    const { tradeId } = req.params;

    const [pro, reviews] = await Promise.all([
      TradePro.findById(tradeId).select('fullName professionality photo avgGrade gradeCount').lean(),
      TradeGrade.find({ trade_id: tradeId })
        .sort({ createdAt: -1 })
        .populate('contractor_id', 'companyName')
        .populate('site_id', 'name')
        .lean(),
    ]);

    if (!pro) return res.status(404).json({ message: 'Trade pro not found.' });

    res.json({
      pro: {
        _id:           String(pro._id),
        fullName:      pro.fullName,
        professionality: pro.professionality,
        photo:         pro.photo ?? null,
        avgGrade:      pro.avgGrade ?? null,
        gradeCount:    pro.gradeCount ?? 0,
      },
      reviews: reviews.map(r => ({
        _id:          String(r._id),
        trade_grade:  r.trade_grade,
        grade_name:   r.grade_name,
        review_text:  r.review_text ?? '',
        photos:       r.photos ?? [],
        date:         r.date,
        createdAt:    r.createdAt,
        contractorName: r.contractor_id?.companyName ?? 'Anonymous',
        siteName:       r.site_id?.name ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
}
