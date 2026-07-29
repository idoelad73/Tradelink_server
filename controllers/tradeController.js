import mongoose from 'mongoose';
import TradePro from '../models/TradePro.js';
import Contractor from '../models/Contractor.js';
import Message from '../models/Message.js';
import Site from '../models/Site.js';
import WorkHoursOrder from '../models/WorkHoursOrder.js';
import Receipt from '../models/Receipt.js';
import TradeGrade, { GRADE_NAMES_MAP } from '../models/TradeGrade.js';
import { parseGrade, normaliseReviewText, sanitisePhotoUrls, canEditGrade } from '../utils/gradeValidation.js';
import jwt from 'jsonwebtoken';
import { uploadPhoto } from '../utils/cloudinary.js';
import { geocodeAddress } from '../utils/geocode.js';
import { getWorkersCommitted } from '../utils/workerSlots.js';

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
    // Badge count = items still awaiting this trade pro's action. The status
    // filter matters: without it an availability request the trade pro already
    // approved kept counting forever, so the navbar badge never cleared. Note
    // 'approval' messages are born status:'approved' (they're contractor→trade
    // notices, not requests), so they correctly never contribute to the badge.
    // getMessages() still returns every status — the modal needs the approved
    // ones both to show history and to derive its same-site/date conflict set.
    const [trade, messageCount] = await Promise.all([
      TradePro.findById(req.userId),
      Message.countDocuments({
        tradePro: req.userId,
        type:     { $in: ['availability', 'approval'] },
        status:   'pending',
      }),
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
        siteId:       siteId ?? undefined,
        siteName,
        siteAddress,
        booking_date: date,
        dates:        [date],
        status:       'booked',
        totalHours:   tradeSlot?.totalHours ?? null,
        workers_no:   workersOffered,
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

      // workers_no is a fixed total set by the contractor — it's never
      // decremented; "assigned" (fully staffed) is derived live instead.
      let isFullyStaffed = true;
      if (slot?.workers_no != null) {
        const alreadyApproved = await getWorkersCommitted(resolvedSiteId, tradeKey);
        isFullyStaffed = alreadyApproved >= slot.workers_no;
      }
      console.log(`[approveBooking] isFullyStaffed=${isFullyStaffed}`);

      const siteSet = {
        'tradesNeeded.$.assigned':     isFullyStaffed,
        'tradesNeeded.$.tradeProId':   tradeId,
        'tradesNeeded.$.requiredDate': date,
      };

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

// GET /api/trade/schedule-bookings
// Every date commitment for this trade pro, read live from the messages
// collection (applications, availability requests, worker offers) rather
// than the tradepros.bookings snapshot — a trade pro can be booked at more
// than one site on the same date (different workers), and the snapshot only
// ever holds one entry per date. 'approval' messages are excluded since
// they're just a notification copy of an 'application'/'availability' that's
// already counted.
export async function getScheduleBookings(req, res, next) {
  try {
    const [messages, trade] = await Promise.all([
      Message.find({
        tradePro: req.userId,
        type: { $in: ['application', 'availability', 'worker_offer'] },
        requestedDate: { $nin: [null, ''] },
      })
        .populate('site', 'name address')
        .select('site contractor requestedDate workersOffered totalHours status tradeName type')
        .lean(),
      TradePro.findById(req.userId).select('professionality').lean(),
    ]);

    // approveMessage() always spawns a 'worker_offer' successor the moment an
    // 'availability' request is approved — the availability record itself never
    // represents a standalone commitment. Keep only the most authoritative record
    // per site(+contractor)/date (worker_offer > application/availability) so this
    // is the single source of truth for BOTH the calendar cell and the action strip —
    // a 'worker_offer' still pending contractor confirmation correctly shows as
    // 'pending', not 'booked', even though the trade's own approval already exists.
    const rank = { worker_offer: 2, application: 1, availability: 1 };
    const bestByKey = new Map();
    for (const m of messages) {
      const key = `${m.site?._id ?? `direct:${m.contractor}`}_${m.requestedDate}_${(m.tradeName || '').toLowerCase()}`;
      const existing = bestByKey.get(key);
      if (!existing || (rank[m.type] ?? 0) > (rank[existing.type] ?? 0)) {
        bestByKey.set(key, m);
      }
    }

    // Message.totalHours is only ever set for direct-search requests — for
    // site-based bookings the minimum-hours guard lives on Site.tradesNeeded,
    // so it has to be looked up per site+trade (same as getMe() already does
    // for tradeObj.bookings). Without this, WorkingHoursModal's min-hours
    // SweetAlert2 never fires for site-based clock lines.
    const siteIds = [...new Set([...bestByKey.values()].filter(m => m.site?._id).map(m => String(m.site._id)))];
    const siteHoursMap = {};
    if (siteIds.length && trade?.professionality) {
      const sites = await Site.find(
        { _id: { $in: siteIds } },
        { 'tradesNeeded.name': 1, 'tradesNeeded.totalHours': 1 }
      ).lean();
      for (const site of sites) {
        const entry = site.tradesNeeded?.find(
          t => t.name?.toLowerCase() === trade.professionality.toLowerCase()
        );
        if (entry) siteHoursMap[String(site._id)] = entry.totalHours ?? null;
      }
    }

    const bookings = [...bestByKey.values()].map((m) => {
      const siteId = m.site?._id ? String(m.site._id) : null;
      return {
        date:         m.requestedDate,
        siteId,
        siteName:     m.site?.name || m.tradeName || '—',
        siteAddress:  m.site?.address || '',
        contractorId: m.contractor ? String(m.contractor) : null,
        workers:      m.workersOffered ?? 1,
        totalHours:   siteId ? (siteHoursMap[siteId] ?? null) : (m.totalHours ?? null),
        status:       ['accepted', 'approved'].includes(m.status) ? 'booked' : 'pending',
      };
    });

    res.json({ bookings });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/trade/messages/:id/approve
export async function approveMessage(req, res, next) {
  try {
    const workersOffered = Math.max(1, parseInt(req.body?.workersOffered) || 1);

    const msg = await Message.findOne({ _id: req.params.id, tradePro: req.userId })
      .populate('site',       'name address tradesNeeded')
      .populate('contractor', 'companyName');
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

    if (msg.site) {
      // Site-linked flow — push booking and notify contractor
      await TradePro.findByIdAndUpdate(req.userId, {
        $pull: { bookings: { siteId: msg.site._id } },
      });
      await TradePro.findByIdAndUpdate(req.userId, {
        $push: { bookings: {
          siteId:       msg.site._id,
          siteName:     msg.site.name,
          siteAddress:  msg.site.address,
          booking_date: msg.requestedDate,
          dates:        [msg.requestedDate],
          status:       'booked',
          totalHours:   totalHours,
          workers_no:   workersOffered,
        }},
      });
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
      console.log(`[approveMessage] worker_offer created — ${pro?.professionality} offering ${workersOffered} workers for "${msg.site.name}"`);
    } else {
      // Direct search — no site, but still mark the date in trade's calendar and notify contractor
      await TradePro.findByIdAndUpdate(req.userId, {
        $push: { bookings: {
          siteId:       null,
          contractorId: msg.contractor?._id ?? msg.contractor ?? null,
          siteName:     msg.contractor?.companyName || tradeName || 'Direct Request',
          siteAddress:  '',
          booking_date: msg.requestedDate,
          dates:        [msg.requestedDate],
          status:       'booked',
          totalHours:   msg.totalHours ?? null,
          workers_no:   workersOffered,
        }},
      });
      await Message.create({
        tradePro:      req.userId,
        site:          null,
        contractor:    msg.contractor,
        requestedDate: msg.requestedDate,
        tradeName:     tradeName,
        workersOffered,
        totalHours:    msg.totalHours ?? null,
        status:        'pending',
        type:          'worker_offer',
        senderType:    'trade',
      });
      console.log(`[approveMessage] direct-search worker_offer created — ${pro?.professionality} offering ${workersOffered} workers on ${msg.requestedDate}`);
    }

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
          name:     { $regex: new RegExp(`^${professionality}$`, 'i') },
          assigned: false,
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
                name:     { $regex: new RegExp(`^${professionality}$`, 'i') },
                assigned: false,
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
        (t) => t.name.toLowerCase() === professionality.toLowerCase() && !t.assigned
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

    // ── Validate worker slots ──────────────────────────────────────────────
    // workers_no is a fixed total set by the contractor — remaining capacity
    // is computed live against everyone else's pending + already-approved
    // commitments (this trade pro's own prior application to this site is
    // excluded since it's about to be replaced by this one).
    const workersNeeded  = tradeEntry.workers_no ?? 0;
    const workersOffered = (Number.isFinite(Number(workers_no)) && Number(workers_no) >= 1)
      ? Math.round(Number(workers_no))
      : 1;

    if (workersNeeded > 0) {
      const totalClaimed = await getWorkersCommitted(
        siteId, pro.professionality, ['accepted', 'approved', 'pending'], req.userId
      );
      const workersLeft = Math.max(0, workersNeeded - totalClaimed);

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
        $push: { bookings: { siteId: site._id, siteName: site.name, siteAddress: site.address, booking_date: date, dates, status: 'order' } },
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

// GET /api/trade/receipts/filters
// Drives the two pickers on the trade pro's receipts search bar. Both lists are
// derived from real documents rather than free text, so the trade pro can only
// filter by values that can actually return a result.
// Unlike the contractor side — where sites come from Site.contractor because the
// contractor owns them — a trade pro owns no sites, so both lists are derived
// from the orders they actually worked (tradehours_orders). Direct/quick-search
// orders carry site_id: null and simply contribute no site entry.
export async function getReceiptFilters(req, res, next) {
  try {
    const [contractorIds, siteIds] = await Promise.all([
      WorkHoursOrder.distinct('contractor_id', { trade_id: req.userId }),
      WorkHoursOrder.distinct('site_id',       { trade_id: req.userId }),
    ]);

    const [contractors, sites] = await Promise.all([
      Contractor.find({ _id: { $in: contractorIds.filter(Boolean) } })
        .select('companyName')
        .sort({ companyName: 1 })
        .lean(),
      Site.find({ _id: { $in: siteIds.filter(Boolean) } })
        .select('name address')
        .sort({ name: 1 })
        .lean(),
    ]);

    res.json({
      contractors: contractors.map((c) => ({
        id:   String(c._id),
        name: c.companyName,
      })),
      sites: sites.map((s) => ({
        id:      String(s._id),
        name:    s.name,
        address: s.address ?? '',
      })),
    });
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

// GET /api/trade/deposit-status?contractorId=...&date=...
// Direct/quick-search bookings only (no siteId). Returns { hasDeposit: bool } —
// true once the contractor has held a deposit ('payment' + status:'deposited')
// for this trade + contractor + date. Used to keep the working-hours clock
// disabled until the deposit actually exists, instead of enabling it as soon
// as the trade pro approves availability.
// Works for BOTH flows: pass siteId for a site-based (project-card) booking, or
// contractorId for a direct/quick-search booking (siteId omitted → site:null).
export async function getDepositStatus(req, res, next) {
  try {
    const { siteId, contractorId, date } = req.query;
    if (!date || (!siteId && !contractorId)) {
      return res.status(400).json({ message: 'date and (siteId or contractorId) are required' });
    }

    const query = {
      tradePro:      req.userId,
      requestedDate: date,
      type:          'payment',
      status:        'deposited',
    };
    if (siteId) query.site = siteId;
    else        { query.site = null; query.contractor = contractorId; }

    const existing = await Message.findOne(query).lean();

    res.json({ hasDeposit: !!existing });
  } catch (err) {
    next(err);
  }
}

// GET /api/trade/deposited-requests
// Bulk list of every direct/quick-search deposit this trade pro has had held —
// { contractorId, date } pairs. Lets the calendar colour a direct-search booked
// day correctly (amber = booked, awaiting deposit; red = deposit held) without
// a round-trip per day.
export async function getDepositedRequests(req, res, next) {
  try {
    const deposits = await Message.find({
      tradePro: req.userId,
      site:     null,
      type:     'payment',
      status:   'deposited',
    }).select('contractor requestedDate').lean();

    res.json({
      deposits: deposits.map(d => ({
        contractorId: String(d.contractor),
        date:         d.requestedDate,
      })),
    });
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
    const { siteId, contractorId, date, totalSeconds, workers_no } = req.body;
    console.log(`[submitWorkLog] siteId=${siteId||'(none)'} contractorId=${contractorId||'(none)'} date=${date} totalSeconds=${totalSeconds} workers_no=${workers_no}`);

    if (!date || totalSeconds == null) {
      console.log(`[submitWorkLog] 400 — missing date or totalSeconds`);
      return res.status(400).json({ message: 'date and totalSeconds are required' });
    }

    const totalSec = Number(totalSeconds);
    if (!Number.isFinite(totalSec) || totalSec <= 0) {
      console.log(`[submitWorkLog] 400 — totalSec=${totalSec} not positive`);
      return res.status(400).json({ message: 'totalSeconds must be a positive number' });
    }

    let site        = null;
    let contractorDoc = null;

    if (siteId) {
      // Normal flow — resolve contractor via site
      site = await Site.findById(siteId).select('contractor').populate('contractor', 'companyName').lean();
      if (!site) return res.status(404).json({ message: 'Site not found' });
      contractorDoc = site.contractor;
      console.log(`[submitWorkLog] site found, contractor=${contractorDoc?._id}`);
    } else if (contractorId) {
      // Direct-search flow — no site, look up contractor directly
      contractorDoc = await Contractor.findById(contractorId).select('_id companyName').lean();
      if (!contractorDoc) return res.status(404).json({ message: 'Contractor not found' });
      console.log(`[submitWorkLog] direct search, contractor=${contractorDoc._id}`);
    } else {
      console.log(`[submitWorkLog] 400 — neither siteId nor contractorId provided`);
      return res.status(400).json({ message: 'siteId or contractorId is required' });
    }

    const pro = await TradePro.findById(req.userId).select('hourlyRate').lean();
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
      site:          siteId || null,
      contractor:    contractorDoc._id,
      requestedDate: date,
      text:          JSON.stringify({ actual_hours, hourly_rate, workers_no: workers_count, order_sum }),
      status:        'pending',
      type:          'payment',
      senderType:    'trade',
    });

    const contractorName = contractorDoc?.companyName ?? '';
    res.status(201).json({ workLog, contractorName });
  } catch (err) {
    next(err);
  }
}

// GET /api/trade/payment-approved/count
// Badge count — only jobs the contractor has actually paid for, i.e. an
// approved WorkHoursOrder row exists (tradehours_orders collection). Deposit
// and pending-submission payment Messages don't count — those exist before
// the job is paid/started and shouldn't light up the "payment approved" icon.
export async function getPaymentApprovedCount(req, res, next) {
  try {
    const count = await WorkHoursOrder.countDocuments({
      trade_id: req.userId,
      status:   'approved',
    });
    res.json({ count });
  } catch (err) {
    next(err);
  }
}

// GET /api/trade/payout-blocked
// Approved work whose payout could not be sent because the trade pro's bank
// details are missing/unverified. Drives the "check your bank account" prompt
// on the trade dashboard so a stuck payout isn't invisible to the person owed.
export async function getPayoutBlocked(req, res, next) {
  try {
    const blocked = await WorkHoursOrder.find({
      trade_id:          req.userId,
      status:            'approved',
      paymentStatus:     'failed',
      payoutBlockedCode: { $ne: null },
    })
      .populate('site_id', 'name')
      .sort({ createdAt: -1 })
      .lean();

    if (!blocked.length) return res.json({ blocked: false });

    const totalOwed = parseFloat(
      blocked.reduce((sum, o) => sum + (o.payment_sum ?? 0), 0).toFixed(2)
    );

    res.json({
      blocked:   true,
      count:     blocked.length,
      totalOwed,
      code:      blocked[0].payoutBlockedCode,
      reason:    blocked[0].payoutBlockedReason,
      jobs: blocked.map(o => ({
        site:   o.site_id?.name ?? '—',
        date:   o.date,
        amount: o.payment_sum ?? 0,
      })),
    });
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
        edited:      (r.editCount ?? 0) > 0,
        editedAt:    r.editedAt ?? null,
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
    const { order_id, trade_grade, review_text, photos } = req.body;
    const grade = parseGrade(trade_grade);
    if (!order_id || grade === null) {
      return res.status(400).json({ message: 'order_id and trade_grade (1–5) are required.' });
    }

    const review = normaliseReviewText(review_text);
    if (!review.ok) return res.status(400).json({ message: review.message });

    // Derive the counterparty from the order rather than trusting the body —
    // otherwise any signed-in trade pro can rate any contractor, on any job,
    // including one that never existed.
    const order = await WorkHoursOrder.findOne({
      _id:      order_id,
      trade_id: req.userId,
      status:   'approved',
    }).lean();

    if (!order) {
      return res.status(404).json({ message: 'No approved order found for this account.' });
    }

    // Ratings lock a short while after submission — see the matching check in
    // contractorController.submitTradeGrade.
    const existing = await TradeGrade.findOne({ order_id: order._id, grade_type: 'contractor' }).lean();
    const editable = canEditGrade(existing);
    if (!editable.allowed) return res.status(409).json({ message: editable.message });

    const photoUrls = sanitisePhotoUrls(photos);

    // Keyed on (order, direction) — see the matching comment in
    // contractorController.submitTradeGrade. Dropping grade_type here overwrites
    // the contractor's review of this trade pro for the same order.
    const doc = await TradeGrade.findOneAndUpdate(
      { order_id: order._id, grade_type: 'contractor' },
      {
        trade_id:      req.userId,
        contractor_id: order.contractor_id,
        site_id:       order.site_id ?? null,
        order_id:      order._id,
        grade_type:   'contractor',
        trade_grade:  grade,
        grade_name:   GRADE_NAMES_MAP[grade],
        review_text:  review.text,
        photos:       photoUrls,
        date:         new Date(),
        ...(existing
          ? { editedAt: new Date(), editCount: (existing.editCount ?? 0) + 1 }
          : {}),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Recalculate contractor's average grade
    const [agg] = await TradeGrade.aggregate([
      { $match: { contractor_id: doc.contractor_id, grade_type: 'contractor' } },
      { $group: { _id: '$contractor_id', avg: { $avg: '$trade_grade' }, count: { $sum: 1 } } },
    ]);

    if (agg) {
      await Contractor.findByIdAndUpdate(doc.contractor_id, {
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

// ── PATCH /trade/working-hours ────────────────────────────────────────────────
export async function updateWorkingHours(req, res, next) {
  try {
    const trade = await TradePro.findByIdAndUpdate(
      req.userId,
      { $set: { workingHours: req.body.workingHours } },
      { new: true }
    );
    res.json({ workingHours: trade.workingHours });
  } catch (err) {
    next(err);
  }
}

// ── POST /trade/portfolio-photos ──────────────────────────────────────────────
export async function addPortfolioPhoto(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
    const trade = await TradePro.findById(req.userId);
    if (!trade) return res.status(404).json({ message: 'Not found.' });
    if (trade.portfolioPhotos.length >= 5) {
      return res.status(400).json({ message: 'Maximum 5 portfolio photos allowed.' });
    }
    const result = await uploadPhoto(req.file.buffer, 'tradelink/portfolio');
    trade.portfolioPhotos.push(result.secure_url);
    await trade.save();
    res.json({ portfolioPhotos: trade.portfolioPhotos });
  } catch (err) {
    next(err);
  }
}

// ── DELETE /trade/portfolio-photos/:index ─────────────────────────────────────
export async function deletePortfolioPhoto(req, res, next) {
  try {
    const idx = Number(req.params.index);
    const trade = await TradePro.findById(req.userId);
    if (!trade) return res.status(404).json({ message: 'Not found.' });
    if (idx < 0 || idx >= trade.portfolioPhotos.length) {
      return res.status(400).json({ message: 'Invalid photo index.' });
    }
    trade.portfolioPhotos.splice(idx, 1);
    await trade.save();
    res.json({ portfolioPhotos: trade.portfolioPhotos });
  } catch (err) {
    next(err);
  }
}
