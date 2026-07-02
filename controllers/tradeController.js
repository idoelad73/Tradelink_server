import mongoose from 'mongoose';
import TradePro from '../models/TradePro.js';
import Contractor from '../models/Contractor.js';
import Message from '../models/Message.js';
import Site from '../models/Site.js';
import WorkHoursOrder from '../models/WorkHoursOrder.js';
import Receipt from '../models/Receipt.js';
import TradeGrade, { GRADE_NAMES_MAP } from '../models/TradeGrade.js';
import jwt from 'jsonwebtoken';
import { uploadPhoto } from '../utils/cloudinary.js';
import { geocodeAddress } from '../utils/geocode.js';

// Force BSON Double so MongoDB stores as Float64, not Int32
const toDouble = (v) => new mongoose.mongo.Double(parseFloat(v));

// ── Working-day helpers (mirrors client-side logic) ───────────────────────────
const _hCache = {};
function _nthWeekday(y, m, wd, n) {
  let c = 0;
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(y, m, d);
    if (dt.getMonth() !== m) break;
    if (dt.getDay() === wd && ++c === n)
      return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
}
function _lastWeekday(y, m, wd) {
  for (let d = new Date(y, m+1, 0).getDate(); d >= 1; d--)
    if (new Date(y, m, d).getDay() === wd)
      return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function getUSHolidays(y) {
  if (_hCache[y]) return _hCache[y];
  const h = new Set();
  [[0,1],[5,19],[6,4],[10,11],[11,25]].forEach(([mo, da]) => {
    const dt = new Date(y, mo, da); const dow = dt.getDay();
    if (dow === 6) dt.setDate(da - 1); else if (dow === 0) dt.setDate(da + 1);
    h.add(`${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`);
  });
  [_nthWeekday(y,0,1,3), _nthWeekday(y,1,1,3), _lastWeekday(y,4,1),
   _nthWeekday(y,8,1,1), _nthWeekday(y,9,1,2), _nthWeekday(y,10,4,4)]
    .filter(Boolean).forEach(d => h.add(d));
  return (_hCache[y] = h);
}
function isWorkingDay(dateStr) {
  const dt = new Date(dateStr + 'T12:00:00'); const dow = dt.getDay();
  return dow !== 0 && dow !== 6 && !getUSHolidays(dt.getFullYear()).has(dateStr);
}
function computeWorkingRange(startDateStr, totalHours) {
  const need = Math.ceil(totalHours / 8);
  const dt = new Date(startDateStr + 'T12:00:00'); const days = [];
  while (days.length < need) {
    const key = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
    if (isWorkingDay(key)) days.push(key);
    dt.setDate(dt.getDate() + 1);
  }
  return days;
}
// GET /api/trade/me
export async function getMe(req, res, next) {
  try {
    const [trade, messageCount] = await Promise.all([
      TradePro.findById(req.userId),
      Message.countDocuments({ tradePro: req.userId, type: { $in: ['availability', 'approval'] } }),
    ]);

    const tradeObj = trade.toObject();

    // ── Enrich bookings with totalHours + workers_no from site + message ──────
    // TradePro.bookings only stores siteId/siteName/dates/status.
    // WorkingHoursModal needs:
    //   • totalHours  — minimum hours guard (from site tradesNeeded)
    //   • workers_no  — workers THIS trade pro is bringing (from accepted application msg)
    if (tradeObj.bookings?.length && tradeObj.professionality) {
      const siteIds = [...new Set(
        tradeObj.bookings.filter(b => b.siteId).map(b => String(b.siteId))
      )];

      if (siteIds.length > 0) {
        // 1. Fetch totalHours from site tradesNeeded
        const [sites, acceptedMsgs] = await Promise.all([
          Site.find(
            { _id: { $in: siteIds } },
            { 'tradesNeeded.name': 1, 'tradesNeeded.totalHours': 1, 'tradesNeeded.budgetType': 1 }
          ).lean(),
          // 2. Fetch workersOffered from the trade pro's accepted application for each site
          Message.find({
            tradePro: req.userId,
            site:     { $in: siteIds },
            type:     'application',
            status:   'accepted',
          }).select('site workersOffered').lean(),
        ]);

        const siteMap = {};
        for (const site of sites) {
          const entry = site.tradesNeeded?.find(
            t => t.name?.toLowerCase() === tradeObj.professionality.toLowerCase()
          );
          if (entry) {
            siteMap[String(site._id)] = {
              totalHours: entry.totalHours ?? null,
              budgetType: entry.budgetType ?? null,
            };
          }
        }

        // workers_no = what this trade pro offered (from their accepted application)
        const workersBySite = {};
        for (const msg of acceptedMsgs) {
          workersBySite[String(msg.site)] = msg.workersOffered ?? 1;
        }

        tradeObj.bookings = tradeObj.bookings.map(b => {
          const siteInfo = siteMap[String(b.siteId)];
          // Booking document stores workers_no directly; fall back to accepted application message
          const workers  = b.workers_no || workersBySite[String(b.siteId)] || 1;
          return siteInfo
            ? { ...b, totalHours: siteInfo.totalHours, budgetType: siteInfo.budgetType, workers_no: workers }
            : { ...b, workers_no: workers };
        });
      }
    }

    res.json({ trade: { ...tradeObj, availabilityMessages: messageCount } });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/trade/me
export async function updateMe(req, res, next) {
  try {
    const { fullName, phone, address, professionality, hourlyRate, locationConsent } = req.body;
    const updates = {};
    if (fullName        !== undefined) updates.fullName        = fullName;
    if (phone           !== undefined) updates.phone           = phone;
    if (address         !== undefined) updates.address         = address;
    if (professionality !== undefined) updates.professionality = professionality;
    if (hourlyRate      !== undefined) updates.hourlyRate      = hourlyRate ? parseFloat(hourlyRate) : null;
    if (locationConsent !== undefined) updates.locationConsent = locationConsent === true || locationConsent === 'true';

    if (req.file) {
      const result = await uploadPhoto(req.file.buffer, 'tradelink/profiles');
      updates.photo = result.secure_url;
    }

    const trade = await TradePro.findByIdAndUpdate(
      req.userId,
      updates,
      { new: true, runValidators: true }
    );
    res.json({ trade });
  } catch (err) {
    next(err);
  }
}

// GET /api/trade/approve-booking?token=...  (public — clicked from email)
export async function approveBooking(req, res) {
  const page = (title, body, color = '#0ea5e9') => `
    <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title} — TradeLink</title>
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;padding:24px}</style>
    </head><body>
    <div style="max-width:480px;width:100%;background:#fff;border-radius:20px;box-shadow:0 4px 32px rgba(0,0,0,.08);overflow:hidden">
      <div style="background:linear-gradient(135deg,${color},#f59e0b);padding:28px;text-align:center">
        <h1 style="color:#fff;font-size:24px;font-weight:800;letter-spacing:-.5px">TradeLink</h1>
      </div>
      <div style="padding:32px;text-align:center">${body}</div>
    </div></body></html>`;

  try {
    const { token } = req.query;
    if (!token) return res.status(400).send(page('Error', '<p style="color:#ef4444;font-size:15px">Missing booking token.</p>', '#ef4444'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { tradeId, date, siteName, siteAddress,
            siteId = null, tradeName = '', workersOffered = 1 } = decoded;

    console.log(`\n[approveBooking] ── TOKEN ────────────────────────────`);
    console.log(`  tradeId       : ${tradeId}`);
    console.log(`  date          : ${date}`);
    console.log(`  siteName      : ${siteName}`);
    console.log(`  siteId        : ${siteId ?? '⚠️  NULL (old token)'}`);
    console.log(`  tradeName     : "${tradeName}"`);
    console.log(`  workersOffered: ${workersOffered}`);

    const pro = await TradePro.findById(tradeId);
    if (!pro) return res.status(404).send(page('Error', '<p style="color:#ef4444;font-size:15px">Trade professional not found.</p>', '#ef4444'));

    console.log(`  pro.professionality: ${pro.professionality}`);

    const displayDate = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    // Fetch site data for totalHours and workers_no calculation
    const site = siteId ? await Site.findById(siteId).select('tradesNeeded').lean() : null;
    const tradeSlot = site?.tradesNeeded?.find(
      (t) => t.name?.toLowerCase() === (tradeName || pro.professionality || '').toLowerCase()
    );
    console.log(`  site found    : ${site ? 'YES' : 'NO (siteId was null)'}`);
    console.log(`  tradeSlot     : ${tradeSlot ? JSON.stringify({ name: tradeSlot.name, workers_no: tradeSlot.workers_no }) : 'NOT FOUND'}`);

    // Pull any existing entry for same site, then push confirmed 'booked' with full context
    await TradePro.findByIdAndUpdate(tradeId, {
      $pull: siteId ? { bookings: { siteId } } : { bookings: { siteName } },
    });
    await TradePro.findByIdAndUpdate(tradeId, {
      $push: { bookings: {
        siteId:      siteId ?? undefined,
        siteName,
        siteAddress,
        dates:       [date],
        status:      'booked',
        totalHours:  tradeSlot?.totalHours ?? null,
        workers_no:  workersOffered,
      }},
    });
    console.log(`[approveBooking] ✓ booking pushed for "${siteName}" on ${date}`);

    // Mark the matching pending availability message as approved
    // Also handles already-approved messages (re-click) by looking up by any status
    const approvedMsg = await Message.findOneAndUpdate(
      { tradePro: tradeId, requestedDate: date, status: 'pending',
        ...(siteId ? { site: siteId } : {}) },
      { status: 'approved' },
      { new: true }
    );
    // Fallback: message may already be approved (link clicked twice) — still find it for siteId
    const msgForSite = approvedMsg
      ?? await Message.findOne({
           tradePro: tradeId, requestedDate: date,
           ...(siteId ? { site: siteId } : {}),
         }).lean();

    console.log(`[approveBooking] approvedMsg : ${approvedMsg ? 'FOUND+UPDATED' : 'null (already approved or not found)'}`);
    console.log(`[approveBooking] msgForSite  : ${msgForSite ? `site=${msgForSite.site}` : 'null'}`);

    // Decrement workers_no and set assigned on the site trade slot
    const resolvedSiteId = siteId || msgForSite?.site;
    console.log(`[approveBooking] resolvedSiteId: ${resolvedSiteId ?? '⚠️  NONE — skipping site update'}`);

    if (resolvedSiteId && pro?.professionality) {
      const resolvedSite = site ?? await Site.findById(resolvedSiteId).select('tradesNeeded').lean();
      const tradeKey = tradeName || pro.professionality;
      const slot = resolvedSite?.tradesNeeded?.find(
        (t) => t.name?.toLowerCase() === tradeKey.toLowerCase()
      );
      console.log(`[approveBooking] slot lookup key="${tradeKey}" → ${slot ? `workers_no=${slot.workers_no}` : '⚠️  NOT FOUND'}`);

      const currentWorkers  = slot?.workers_no ?? 0;
      const newWorkersCount = Math.max(0, currentWorkers - workersOffered);
      const totalHours      = slot?.totalHours ?? null;
      const newTotalWorkingHrs = (slot?.budgetType === 'hours' && totalHours)
        ? totalHours * newWorkersCount : null;

      console.log(`[approveBooking] workers: ${currentWorkers} → ${newWorkersCount} (offered ${workersOffered})`);

      const siteSet = {
        'tradesNeeded.$.assigned':     true,
        'tradesNeeded.$.tradeProId':   tradeId,
        'tradesNeeded.$.workers_no':   newWorkersCount,
        'tradesNeeded.$.requiredDate': date,
      };
      if (newTotalWorkingHrs !== null) siteSet['tradesNeeded.$.totalWorkingHrs'] = newTotalWorkingHrs;

      const updateResult = await Site.updateOne(
        {
          _id: resolvedSiteId,
          'tradesNeeded.name': { $regex: new RegExp(`^${tradeKey}$`, 'i') },
        },
        { $set: siteSet }
      );
      console.log(`[approveBooking] Site.updateOne result: matched=${updateResult.matchedCount} modified=${updateResult.modifiedCount}`);
    } else {
      console.log(`[approveBooking] ⚠️  SKIPPED site update — resolvedSiteId=${resolvedSiteId} professionality=${pro?.professionality}`);
    }

    const body = `
      <div style="font-size:48px;margin-bottom:16px">✅</div>
      <h2 style="color:#0f172a;font-size:20px;font-weight:800;margin-bottom:8px">You're confirmed!</h2>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin-bottom:20px">
        Hi <strong>${pro.fullName}</strong>, your availability for the job below has been recorded.
      </p>
      <div style="background:#f0f9ff;border:2px solid #0ea5e9;border-radius:12px;padding:16px;margin-bottom:8px">
        <p style="color:#0369a1;font-size:16px;font-weight:800;margin-bottom:6px">📅 ${displayDate}</p>
        <p style="color:#0f172a;font-size:14px;font-weight:700;margin-bottom:2px">🏗️ ${siteName}</p>
        ${siteAddress ? `<p style="color:#64748b;font-size:13px">📍 ${siteAddress}</p>` : ''}
      </div>
      <p style="color:#94a3b8;font-size:12px;margin-top:16px">This day has been marked as booked in your TradeLink calendar.</p>`;

    res.send(page('Booking Confirmed', body));
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(400).send(page('Link Expired', '<p style="color:#f59e0b;font-size:15px">This approval link has expired. Please ask the contractor to send a new request.</p>', '#f59e0b'));
    }
    res.status(400).send(page('Invalid Link', '<p style="color:#ef4444;font-size:15px">This link is invalid or has already been used.</p>', '#ef4444'));
  }
}

// PATCH /api/trade/location
// body: { lat, lng }  — called every minute from the trade dashboard
export async function updateLocation(req, res, next) {
  try {
    const { lat, lng } = req.body;
    if (lat === undefined || lng === undefined)
      return res.status(400).json({ message: 'lat and lng are required' });

    // Use raw collection API to bypass Mongoose schema casting.
    // Mongoose's Number caster calls .valueOf() on BSON Double objects,
    // converting them back to plain JS numbers which the driver stores as Int32.
    const { Double } = mongoose.mongo;
    await TradePro.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(req.userId) },
      { $set: {
        'location.type': 'Point',
        'location.coordinates': [new Double(parseFloat(lng)), new Double(parseFloat(lat))],
      }}
    );

    console.log(`[updateLocation] ${req.userId} → lat=${lat}, lng=${lng}`);
    res.json({ message: 'Location updated' });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/trade/schedule
// body: { busyDays: ["2026-05-18", "2026-05-22", ...] }
export async function updateSchedule(req, res, next) {
  try {
    const { busyDays } = req.body;
    const trade = await TradePro.findByIdAndUpdate(
      req.userId,
      { busyDays: Array.isArray(busyDays) ? busyDays : [] },
      { new: true }
    );
    res.json({ busyDays: trade.busyDays });
  } catch (err) {
    next(err);
  }
}

// GET /api/trade/messages
// Returns availability requests + approvals sent TO this trade pro (not their own applications)
export async function getMessages(req, res, next) {
  try {
    const messages = await Message.find({
      tradePro: req.userId,
      type: { $in: ['availability', 'approval'] },
    })
      .populate('site',       'name address type photo tradesNeeded')
      .populate('contractor', 'companyName email')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ messages });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/trade/messages/:id/approve
export async function approveMessage(req, res, next) {
  try {
    const workersOffered = Math.max(1, parseInt(req.body?.workersOffered) || 1);

    const msg = await Message.findOne({ _id: req.params.id, tradePro: req.userId })
      .populate('site', 'name address tradesNeeded');
    if (!msg) return res.status(404).json({ message: 'Message not found' });
    if (msg.status === 'approved') return res.json({ message: 'Already approved' });

    const pro = await TradePro.findById(req.userId).select('professionality');

    // Find the relevant trade slot for context
    const tradeName = msg.tradeName || pro?.professionality || '';
    const tradeSlot = msg.site?.tradesNeeded?.find(
      (t) => t.name?.toLowerCase() === tradeName.toLowerCase()
    );

    const totalHours = tradeSlot?.totalHours ?? null;

    // Mark availability message as approved + save workers chosen by trade pro
    msg.status         = 'approved';
    msg.workersOffered = workersOffered;
    await msg.save();

    // Push booking onto trade pro (confirmed from their side, pending contractor acknowledgement)
    await TradePro.findByIdAndUpdate(req.userId, {
      $pull: { bookings: { siteId: msg.site._id } },
    });
    await TradePro.findByIdAndUpdate(req.userId, {
      $push: { bookings: {
        siteId:      msg.site._id,
        siteName:    msg.site.name,
        siteAddress: msg.site.address,
        dates:       [msg.requestedDate],
        status:      'booked',
        totalHours:  totalHours,
        workers_no:  workersOffered,
      }},
    });

    // Create a worker_offer message for the contractor to approve.
    // workers_no on the site is only decremented after contractor approves.
    await Message.create({
      tradePro:      req.userId,
      site:          msg.site._id,
      contractor:    msg.contractor,
      requestedDate: msg.requestedDate,
      tradeName:     tradeName,
      workersOffered,
      status:        'pending',
      type:          'worker_offer',
      senderType:    'trade',
    });

    console.log(`[approveMessage] worker_offer created — ${pro?.professionality} offering ${workersOffered} workers for "${msg.site?.name}"`);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// POST /api/trade/reschedule
// Trade pro requests a new date for an existing booking — sends pending message to contractor
export async function requestReschedule(req, res, next) {
  try {
    const { siteId, newDate } = req.body;
    if (!siteId || !newDate) return res.status(400).json({ message: 'siteId and newDate required' });

    const pro = await TradePro.findById(req.userId).select('fullName professionality busyDays bookings');
    if (!pro) return res.status(404).json({ message: 'Trade pro not found' });

    // Availability check — new date must not already be busy or booked
    const isBusy   = pro.busyDays?.includes(newDate);
    const isBooked = pro.bookings?.some(b => b.dates?.includes(newDate));
    if (isBusy || isBooked) {
      return res.status(409).json({ notAvailable: true });
    }

    const site = await Site.findById(siteId).select('contractor name address');
    if (!site) return res.status(404).json({ message: 'Site not found' });

    // Create a reschedule request message to the contractor
    await Message.create({
      tradePro:      req.userId,
      site:          siteId,
      contractor:    site.contractor,
      requestedDate: newDate,
      status:        'pending',
      senderType:    'trade',
      type:          'reschedule',
    });

    res.json({ ok: true, siteName: site.name });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/trade/bookings
// Trade pro removes a booking and resets the site's assignment
export async function removeBooking(req, res, next) {
  try {
    const { siteId } = req.body;
    if (!siteId) return res.status(400).json({ message: 'siteId required' });

    const pro = await TradePro.findById(req.userId).select('professionality');
    if (!pro) return res.status(404).json({ message: 'Trade pro not found' });

    // Remove all bookings for this site from the trade pro
    await TradePro.findByIdAndUpdate(req.userId, {
      $pull: { bookings: { siteId: siteId } },
    });

    // Reset assignment on site's tradesNeeded entry
    await Site.updateOne(
      { _id: siteId, 'tradesNeeded.tradeProId': req.userId },
      { $set: { 'tradesNeeded.$.assigned': false, 'tradesNeeded.$.tradeProId': null } }
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// GET /api/trade/find-jobs?distance=25&unit=mi
export async function findJobs(req, res, next) {
  try {
    const pro = await TradePro.findById(req.userId).select('professionality location hourlyRate bookings');
    if (!pro) return res.status(404).json({ message: 'Trade pro not found' });

    const [lng, lat] = pro.location.coordinates;
    if (lng === 0 && lat === 0) {
      return res.status(422).json({ message: 'no_location' });
    }

    const { distance = '25', unit = 'mi' } = req.query;
    const meters = unit === 'km'
      ? parseFloat(distance) * 1000
      : parseFloat(distance) * 1609.344;

    const professionality = pro.professionality;

    // ── Build exclusion sets from confirmed bookings (status:'booked') ────────
    // bookedSiteIds : sites this trade is already working on → hide entirely
    // bookedDates   : confirmed dates → hide any site whose requiredDate clashes
    const confirmedBookings = (pro.bookings ?? []).filter(b => b.status === 'booked');
    const bookedSiteIds = new Set(confirmedBookings.filter(b => b.siteId).map(b => String(b.siteId)));
    const bookedDates   = new Set(confirmedBookings.flatMap(b => b.dates ?? []));

    // Also exclude sites where the trade already has an accepted application
    const acceptedSiteIds = await Message.find({
      tradePro: req.userId,
      type:     'application',
      status:   'accepted',
    }).distinct('site');
    acceptedSiteIds.forEach(id => bookedSiteIds.add(String(id)));

    // Geocode any active sites that still have placeholder [0,0] coordinates
    const ungeocoded = await Site.find({
      status: 'active',
      'location.coordinates': [0, 0],
      tradesNeeded: {
        $elemMatch: {
          name: { $regex: new RegExp(`^${professionality}$`, 'i') },
          $or: [{ assigned: false }, { workers_no: { $gt: 0 } }],
        },
      },
    }).select('_id address');

    await Promise.all(ungeocoded.map(async (s) => {
      const coords = await geocodeAddress(s.address).catch(() => null);
      if (coords) {
        const { Double } = mongoose.mongo;
        await Site.collection.updateOne(
          { _id: s._id },
          { $set: {
            'location.type': 'Point',
            'location.coordinates': [new Double(parseFloat(coords.lng)), new Double(parseFloat(coords.lat))],
          }}
        );
      }
    }));

    const pipeline = [
      {
        $geoNear: {
          near:          { type: 'Point', coordinates: [toDouble(lng), toDouble(lat)] },
          distanceField: 'distanceMeters',
          maxDistance:   meters,
          query: {
            status: 'active',
            tradesNeeded: {
              $elemMatch: {
                name: { $regex: new RegExp(`^${professionality}$`, 'i') },
                $or: [{ assigned: false }, { workers_no: { $gt: 0 } }],
              },
            },
          },
          spherical: true,
        },
      },
      {
        $lookup: {
          from:         'contractors',
          localField:   'contractor',
          foreignField: '_id',
          as:           'contractorInfo',
        },
      },
      { $unwind: { path: '$contractorInfo', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: 1, address: 1, type: 1, photo: 1,
          tradesNeeded: 1, distanceMeters: 1,
          'contractorInfo._id': 1,
          'contractorInfo.companyName': 1,
          'contractorInfo.avgGrade': 1,
          'contractorInfo.gradeCount': 1,
        },
      },
    ];

    const sites = await Site.aggregate(pipeline);
    console.log(`[findJobs] pro=${req.userId} trade="${professionality}" lat=${lat} lng=${lng} dist=${meters}m → ${sites.length} site(s) found`);

    const filtered = sites.filter(site => {
      if (bookedSiteIds.has(String(site._id))) return false;
      const tradeEntry = site.tradesNeeded?.find(
        (t) => t.name.toLowerCase() === professionality.toLowerCase()
      );
      if (tradeEntry?.requiredDate && bookedDates.has(tradeEntry.requiredDate)) return false;
      return true;
    });

    // Attach deposit status per site+trade from payment messages
    const filteredSiteIds = filtered.map(s => s._id);
    const depositMsgs = await Message.find({
      site:   { $in: filteredSiteIds },
      type:   'payment',
      status: 'deposited',
    }).select('site tradeName min_deposit').lean();
    const depositMap = new Map(depositMsgs.map(m => [`${m.site}::${m.tradeName}`, m.min_deposit ?? null]));

    const results = filtered.map((site) => {
      const trade = site.tradesNeeded.find(
        (t) => t.name.toLowerCase() === professionality.toLowerCase() && (!t.assigned || t.workers_no > 0)
      );
      const depositKey    = trade ? `${site._id}::${trade.name}` : null;
      const depositHeld   = depositKey ? depositMap.has(depositKey) : false;
      const depositAmount = depositKey ? (depositMap.get(depositKey) ?? null) : null;
      return {
        _id:            site._id,
        name:           site.name,
        address:        site.address,
        type:           site.type,
        photo:          site.photo,
        distanceMeters: site.distanceMeters,
        tradeEntry:     trade ? { ...trade, depositHeld, depositAmount } : null,
        contractorId:         site.contractorInfo?._id || null,
        contractorName:       site.contractorInfo?.companyName || null,
        contractorAvgGrade:   site.contractorInfo?.avgGrade  ?? null,
        contractorGradeCount: site.contractorInfo?.gradeCount ?? 0,
      };
    });

    // Sort by contractor avgGrade descending — highest-rated contractors first
    results.sort((a, b) => (b.contractorAvgGrade ?? 0) - (a.contractorAvgGrade ?? 0));

    res.json({ results, professionality, hourlyRate: pro.hourlyRate ?? null });
  } catch (err) {
    next(err);
  }
}

// POST /api/trade/jobs/:siteId/apply
export async function applyToJob(req, res, next) {
  try {
    const { siteId } = req.params;
    const { lang = 'en', date, workers_no } = req.body;

    const [pro, site] = await Promise.all([
      TradePro.findById(req.userId).select('fullName professionality photo hourlyRate email'),
      Site.findById(siteId).populate('contractor', 'companyName email'),
    ]);
    if (!pro)  return res.status(404).json({ message: 'Trade pro not found' });
    if (!site) return res.status(404).json({ message: 'Site not found' });

    // Block only if the position is already filled (assigned:true in site)
    const tradeEntry = site.tradesNeeded?.find(
      (t) => t.name.toLowerCase() === pro.professionality.toLowerCase()
    );
    if (!tradeEntry || tradeEntry.assigned) {
      return res.status(409).json({ assigned: true, siteName: site.name });
    }

    // ── Validate worker slots (same logic as askAvailability) ─────────────────
    const workersNeeded  = tradeEntry.workers_no ?? 0;
    const workersOffered = (Number.isFinite(Number(workers_no)) && Number(workers_no) >= 1)
      ? Math.round(Number(workers_no))
      : 1;

    if (workersNeeded > 0) {
      const pendingMsgs = await Message.find({
        site:       siteId,
        type:       'application',
        status:     'pending',
        tradeName:  { $regex: new RegExp(`^${pro.professionality}$`, 'i') },
      }).select('workersOffered');
      const totalPending = pendingMsgs.reduce((s, m) => s + (m.workersOffered || 1), 0);
      const workersLeft  = Math.max(0, workersNeeded - totalPending);

      if (workersLeft <= 0) {
        return res.status(409).json({ slotsFull: true, message: 'All worker slots are currently full.' });
      }
      if (workersOffered > workersLeft) {
        return res.status(409).json({ tooMany: true, workersLeft, message: `Only ${workersLeft} slot(s) remaining.` });
      }
    }

    // Upsert: single Message record with type:'application' replaces the old
    // Application collection — one document tracks the whole flow.
    await Message.findOneAndUpdate(
      { tradePro: req.userId, site: siteId, type: 'application' },
      { $set: {
          contractor:    site.contractor._id,
          requestedDate: date || '',
          status:        'pending',
          senderType:    'trade',
          tradeName:     pro.professionality,
          workersOffered,
        }
      },
      { upsert: true, new: true }
    );

    // Push/replace booking in TradePro with status 'order' (orange on calendar)
    if (date) {
      const dates = (tradeEntry.budgetType === 'hours' && tradeEntry.totalHours)
        ? computeWorkingRange(date, tradeEntry.totalHours)
        : [date];
      await TradePro.findByIdAndUpdate(req.userId, {
        $pull: { bookings: { siteId: site._id, status: 'order' } },
      });
      await TradePro.findByIdAndUpdate(req.userId, {
        $push: { bookings: { siteId: site._id, siteName: site.name, siteAddress: site.address, dates, status: 'order' } },
      });
    }

    // Email to contractor
    const locale      = lang === 'es' ? 'es-ES' : 'en-US';
    const contractorEmail = site.contractor?.email;
    const companyName     = site.contractor?.companyName || 'Contractor';

    res.json({ ok: true, siteName: site.name, contractorName: companyName });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ duplicate: true });
    }
    next(err);
  }
}

// GET /api/trade/approved-orders
// Called on TradeDashboard mount. Returns minimal approved records so the client can:
//   1. Colour those calendar days light-blue
//   2. Disable the clock icon (can't log hours twice for an approved date)
// GET /api/trade/receipts
export async function getMyReceipts(req, res, next) {
  try {
    const { contractorName, siteName, dateFrom, dateTo } = req.query;

    const filter = { trade_id: req.userId, receipt_type: 'trade' };

    if (contractorName) filter.contractor_name = { $regex: contractorName.trim(), $options: 'i' };
    if (siteName)       filter.site_name       = { $regex: siteName.trim(),       $options: 'i' };
    if (dateFrom || dateTo) {
      filter.date = {};
      if (dateFrom) filter.date.$gte = dateFrom;
      if (dateTo)   filter.date.$lte = dateTo;
    }

    const receipts = await Receipt.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ receipts });
  } catch (err) {
    next(err);
  }
}

// GET /api/trade/orders — all WorkHoursOrders for this trade pro (receipts)
export async function getMyOrders(req, res, next) {
  try {
    const orders = await WorkHoursOrder.find({ trade_id: req.userId })
      .populate('contractor_id', 'companyName')
      .populate('site_id',       'name address')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ orders });
  } catch (err) {
    next(err);
  }
}

export async function getApprovedOrderDates(req, res, next) {
  try {
    const orders = await WorkHoursOrder.find({ trade_id: req.userId, status: 'approved' })
      .select('date site_id')
      .lean();
    // Return as an array of { date, siteId } — small payload, fast to parse on client
    res.json({ orders: orders.map(o => ({ date: o.date, siteId: String(o.site_id) })) });
  } catch (err) {
    next(err);
  }
}

// GET /api/trade/work-log/check?siteId=...&date=...
// Returns { hasPending: bool } — true if there is already a pending payment
// message for this trade + site + date. Used by the client to disable the
// clock icon so a trade cannot submit duplicate hours for the same day.
export async function checkWorkLog(req, res, next) {
  try {
    const { siteId, date } = req.query;
    if (!siteId || !date) {
      return res.status(400).json({ message: 'siteId and date are required' });
    }

    const existing = await Message.findOne({
      tradePro:      req.userId,
      site:          siteId,
      requestedDate: date,
      type:          'payment',
      status:        'pending',
    }).lean();

    res.json({ hasPending: !!existing });
  } catch (err) {
    next(err);
  }
}

// POST /api/trade/work-log
// Trade pro submits actual hours worked for a booking date.
// Creates a payment_pending Message — tradehours_orders is ONLY written to when
// the contractor approves (via updatePaymentApproval). This keeps the collection
// as a clean approved-only billing ledger.
export async function submitWorkLog(req, res, next) {
  try {
    const { siteId, date, totalSeconds, workers_no } = req.body;

    if (!siteId || !date || totalSeconds == null) {
      return res.status(400).json({ message: 'siteId, date and totalSeconds are required' });
    }

    const totalSec = Number(totalSeconds);
    if (!Number.isFinite(totalSec) || totalSec <= 0) {
      return res.status(400).json({ message: 'totalSeconds must be a positive number' });
    }

    // Fetch both in parallel — site for contractor ref + name, pro for current hourlyRate
    const [site, pro] = await Promise.all([
      Site.findById(siteId).select('contractor').populate('contractor', 'companyName').lean(),
      TradePro.findById(req.userId).select('hourlyRate').lean(),
    ]);

    if (!site) return res.status(404).json({ message: 'Site not found' });
    if (!pro)  return res.status(404).json({ message: 'Trade pro not found' });

    const actual_hours  = parseFloat((totalSec / 3600).toFixed(2));
    const hourly_rate   = pro.hourlyRate ?? null;
    const workers_count = (Number.isFinite(Number(workers_no)) && Number(workers_no) > 0)
      ? Number(workers_no)
      : 1;
    // order_sum = hours × rate × workers (covers the full team cost)
    const order_sum = parseFloat((actual_hours * (hourly_rate ?? 0) * workers_count).toFixed(2));

    // Store as a pending payment message — contractor will approve/reject from their dashboard.
    // The snapshot (hours / rate / sum) is JSON-encoded in the text field so the
    // data is preserved until the contractor acts. type='payment', status drives the colour.
    const workLog = await Message.create({
      tradePro:      req.userId,
      site:          siteId,
      contractor:    site.contractor,
      requestedDate: date,
      text:          JSON.stringify({ actual_hours, hourly_rate, workers_no: workers_count, order_sum }),
      status:        'pending',
      type:          'payment',
      senderType:    'trade',
    });

    const contractorName = site.contractor?.companyName ?? '';
    res.status(201).json({ workLog, contractorName });
  } catch (err) {
    next(err);
  }
}

// GET /api/trade/payment-approved/count
// Badge count — all payment messages (any status) so the trade always sees
// any activity on their submitted hours.
export async function getPaymentApprovedCount(req, res, next) {
  try {
    const count = await Message.countDocuments({
      tradePro: req.userId,
      type:     'payment',
    });
    res.json({ count });
  } catch (err) {
    next(err);
  }
}

// GET /api/trade/payment-approved
// Returns:
//   orders   — approved tradehours_orders (clean billing ledger)
//   rejected — payment_rejected messages (snapshot in text field)
//   pending  — payment_pending messages (submitted, awaiting contractor action)
// tradehours_orders is a clean approved-only ledger; all other states live in messages.
export async function getPaymentApproved(req, res, next) {
  try {
    const [orders, rejectedMsgs, pendingMsgs] = await Promise.all([
      WorkHoursOrder.find({ trade_id: req.userId, status: 'approved' })
        .populate('site_id',       'name address')
        .populate('contractor_id', 'companyName')
        .sort({ createdAt: -1 })
        .lean(),

      Message.find({ tradePro: req.userId, type: 'payment', status: 'rejected' })
        .populate('site',       'name address')
        .populate('contractor', 'companyName')
        .sort({ createdAt: -1 })
        .lean(),

      Message.find({ tradePro: req.userId, type: 'payment', status: 'pending' })
        .populate('site',       'name address')
        .populate('contractor', 'companyName')
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const parseSnap = (m) => { try { return JSON.parse(m.text || '{}'); } catch { return {}; } };

    // Normalize rejected messages into the same shape as order rows
    const rejected = rejectedMsgs.map((m) => {
      const snapshot = parseSnap(m);
      return {
        _id:           m._id,
        _isRejected:   true,
        date:          m.requestedDate,
        site_id:       m.site       ?? null,
        contractor_id: m.contractor ?? null,
        actual_hours:  snapshot.actual_hours ?? 0,
        hourly_rate:   snapshot.hourly_rate  ?? null,
        order_sum:     snapshot.order_sum    ?? 0,
        createdAt:     m.createdAt,
      };
    });

    // Normalize pending messages the same way
    const pending = pendingMsgs.map((m) => {
      const snapshot = parseSnap(m);
      return {
        _id:           m._id,
        _isPending:    true,
        date:          m.requestedDate,
        site_id:       m.site       ?? null,
        contractor_id: m.contractor ?? null,
        actual_hours:  snapshot.actual_hours ?? 0,
        hourly_rate:   snapshot.hourly_rate  ?? null,
        order_sum:     snapshot.order_sum    ?? 0,
        createdAt:     m.createdAt,
      };
    });

    res.json({ orders, rejected, pending });
  } catch (err) {
    next(err);
  }
}

// ── GET /trade/contractor-grades/eligible ─────────────────────────────────────
// Returns all contractors this trade pro has approved/paid orders with but
// hasn't graded yet. Uses the { trade_id: 1, createdAt: -1 } index on orders.
export async function getGradableContractors(req, res, next) {
  try {
    // All orders for this trade pro that are approved
    const orders = await WorkHoursOrder.find({
      trade_id: req.userId,
      status:   'approved',
    })
      .populate('contractor_id', 'companyName email address')
      .populate('site_id', 'name')
      .sort({ createdAt: -1 })
      .lean();

    // Grades already submitted by this trade pro for contractors
    const submitted = await TradeGrade.find({
      trade_id:   req.userId,
      grade_type: 'contractor',
    }).select('order_id').lean();
    const gradedOrderIds = new Set(submitted.map(g => String(g.order_id)));

    const gradable = orders
      .filter(o => !gradedOrderIds.has(String(o._id)))
      .map(o => ({
        order_id:        String(o._id),
        contractor_id:   String(o.contractor_id?._id ?? o.contractor_id),
        contractor_name: o.contractor_id?.companyName ?? 'Unknown',
        contractor_email:o.contractor_id?.email ?? '',
        site_id:         o.site_id ? String(o.site_id._id ?? o.site_id) : null,
        site_name:       o.site_id?.name ?? null,
        date:            o.date,
        order_sum:       o.order_sum,
      }));

    res.json({ contractors: gradable });
  } catch (err) {
    next(err);
  }
}

// ── GET /trade/contractor-grades/:contractorId/reviews ────────────────────────
// Returns contractor profile + all 'contractor'-type grades submitted by trade pros.
export async function getContractorReviews(req, res, next) {
  try {
    const { contractorId } = req.params;

    const contractor = await Contractor.findById(contractorId)
      .select('companyName address avgGrade gradeCount')
      .lean();
    if (!contractor) return res.status(404).json({ message: 'Contractor not found.' });

    const reviews = await TradeGrade.find({ contractor_id: contractorId, grade_type: 'contractor' })
      .populate('trade_id', 'fullName professionality photo')
      .populate('site_id',  'name')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      contractor: {
        companyName: contractor.companyName,
        address:     contractor.address,
        avgGrade:    contractor.avgGrade,
        gradeCount:  contractor.gradeCount,
      },
      reviews: reviews.map(r => ({
        _id:         r._id,
        trade_grade: r.trade_grade,
        grade_name:  r.grade_name,
        review_text: r.review_text,
        photos:      r.photos ?? [],
        createdAt:   r.createdAt,
        date:        r.date,
        tradeName:   r.trade_id?.fullName ?? 'Unknown',
        tradeProfessionality: r.trade_id?.professionality ?? null,
        siteName:    r.site_id?.name ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /trade/contractor-grades/photo ───────────────────────────────────────
// Upload a single contractor-grade review photo to Cloudinary.
export async function uploadContractorGradePhoto(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
    const result = await uploadPhoto(req.file.buffer, 'tradelink/grade-photos');
    res.json({ url: result.secure_url });
  } catch (err) {
    next(err);
  }
}

// ── POST /trade/contractor-grades ─────────────────────────────────────────────
// Trade pro submits a grade (1–5) for a contractor.
export async function submitContractorGrade(req, res, next) {
  try {
    const { contractor_id, site_id, order_id, trade_grade, review_text, photos } = req.body;
    const grade = parseInt(trade_grade, 10);
    if (!contractor_id || !order_id || isNaN(grade) || grade < 1 || grade > 5) {
      return res.status(400).json({ message: 'contractor_id, order_id and trade_grade (1–5) are required.' });
    }

    const photoUrls = Array.isArray(photos)
      ? photos.filter(u => typeof u === 'string' && u.startsWith('http'))
      : [];

    const doc = await TradeGrade.findOneAndUpdate(
      { trade_id: req.userId, order_id },
      {
        trade_id:     req.userId,
        contractor_id,
        site_id:      site_id || null,
        order_id,
        grade_type:   'contractor',
        trade_grade:  grade,
        grade_name:   GRADE_NAMES_MAP[grade],
        review_text:  (review_text ?? '').trim(),
        photos:       photoUrls,
        date:         new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Recalculate contractor's average grade
    const [agg] = await TradeGrade.aggregate([
      { $match: { contractor_id: doc.contractor_id, grade_type: 'contractor' } },
      { $group: { _id: '$contractor_id', avg: { $avg: '$trade_grade' }, count: { $sum: 1 } } },
    ]);

    if (agg) {
      await Contractor.findByIdAndUpdate(contractor_id, {
        avgGrade:   Math.round(agg.avg * 10) / 10,
        gradeCount: agg.count,
      });
    }

    res.status(201).json({ grade: doc, avgGrade: agg?.avg ?? grade, gradeCount: agg?.count ?? 1 });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Already graded.' });
    next(err);
  }
}
