import TradePro from '../models/TradePro.js';
import Contractor from '../models/Contractor.js';
import Message from '../models/Message.js';
import Site from '../models/Site.js';
import Application from '../models/Application.js';
import jwt from 'jsonwebtoken';
import { uploadPhoto } from '../utils/cloudinary.js';
import { geocodeAddress } from '../utils/geocode.js';
import { sendMail } from '../utils/mailer.js';

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
      Message.countDocuments({ tradePro: req.userId }),
    ]);
    res.json({ trade: { ...trade.toObject(), availabilityMessages: messageCount } });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/trade/me
export async function updateMe(req, res, next) {
  try {
    const { fullName, phone, address, professionality, hourlyRate } = req.body;
    const updates = {};
    if (fullName        !== undefined) updates.fullName        = fullName;
    if (phone           !== undefined) updates.phone           = phone;
    if (address         !== undefined) updates.address         = address;
    if (professionality !== undefined) updates.professionality = professionality;
    if (hourlyRate      !== undefined) updates.hourlyRate      = hourlyRate ? parseFloat(hourlyRate) : null;

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
    const { tradeId, date, siteName, siteAddress } = decoded;

    const pro = await TradePro.findById(tradeId);
    if (!pro) return res.status(404).send(page('Error', '<p style="color:#ef4444;font-size:15px">Trade professional not found.</p>', '#ef4444'));

    const displayDate = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const alreadyBooked = pro.bookings?.some(
      (b) => b.dates?.includes(date) && b.siteName === siteName
    );
    if (!alreadyBooked) {
      await TradePro.findByIdAndUpdate(tradeId, {
        $push: { bookings: { siteName, siteAddress, dates: [date], status: 'booked' } },
      });
      console.log(`[approveBooking] ${pro.fullName} confirmed for "${siteName}" on ${date}`);
    }

    // Mark the matching pending message as approved and set assigned:true on the site
    const approvedMsg = await Message.findOneAndUpdate(
      { tradePro: tradeId, requestedDate: date, status: 'pending' },
      { status: 'approved' },
      { new: true }
    );
    if (approvedMsg?.site && pro?.professionality) {
      await Site.updateOne(
        {
          _id: approvedMsg.site,
          'tradesNeeded.name': { $regex: new RegExp(`^${pro.professionality}$`, 'i') },
        },
        { $set: { 'tradesNeeded.$.assigned': true, 'tradesNeeded.$.tradeProId': tradeId } }
      );
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

    await TradePro.findByIdAndUpdate(req.userId, {
      location: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
    });

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
export async function getMessages(req, res, next) {
  try {
    const messages = await Message.find({ tradePro: req.userId })
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
    const msg = await Message.findOne({ _id: req.params.id, tradePro: req.userId })
      .populate('site', 'name address');
    if (!msg) return res.status(404).json({ message: 'Message not found' });
    if (msg.status === 'approved') return res.json({ message: 'Already approved' });

    // Mark approved
    msg.status = 'approved';
    await msg.save();

    // Push booking into TradePro bookings using dates[] array format
    const alreadyBooked = await TradePro.findOne({
      _id: req.userId,
      'bookings.dates': msg.requestedDate,
      'bookings.siteName': msg.site.name,
    });
    if (!alreadyBooked) {
      await TradePro.findByIdAndUpdate(req.userId, {
        $push: { bookings: {
          siteId:      msg.site._id,
          siteName:    msg.site.name,
          siteAddress: msg.site.address,
          dates:       [msg.requestedDate],
          status:      'booked',
        }},
      });
    }

    // Set assigned:true on the site's tradesNeeded entry immediately
    const pro = await TradePro.findById(req.userId).select('professionality');
    if (pro?.professionality && msg.site?._id) {
      await Site.updateOne(
        {
          _id: msg.site._id,
          'tradesNeeded.name': { $regex: new RegExp(`^${pro.professionality}$`, 'i') },
        },
        { $set: { 'tradesNeeded.$.assigned': true, 'tradesNeeded.$.tradeProId': req.userId } }
      );
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// GET /api/trade/find-jobs?distance=25&unit=mi
export async function findJobs(req, res, next) {
  try {
    const pro = await TradePro.findById(req.userId).select('professionality location hourlyRate');
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

    // Geocode any active sites that still have placeholder [0,0] coordinates
    const ungeocoded = await Site.find({
      status: 'active',
      'location.coordinates': [0, 0],
      tradesNeeded: { $elemMatch: { name: { $regex: new RegExp(`^${professionality}$`, 'i') }, assigned: false } },
    }).select('_id address');

    await Promise.all(ungeocoded.map(async (s) => {
      const coords = await geocodeAddress(s.address).catch(() => null);
      if (coords) {
        await Site.findByIdAndUpdate(s._id, {
          location: { type: 'Point', coordinates: [coords.lng, coords.lat] },
        });
      }
    }));

    const pipeline = [
      {
        $geoNear: {
          near:          { type: 'Point', coordinates: [lng, lat] },
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
        },
      },
    ];

    const sites = await Site.aggregate(pipeline);
    console.log(`[findJobs] pro=${req.userId} trade="${professionality}" lat=${lat} lng=${lng} dist=${meters}m → ${sites.length} site(s) found`);

    const results = sites.map((site) => {
      const trade = site.tradesNeeded.find(
        (t) => t.name.toLowerCase() === professionality.toLowerCase() && !t.assigned
      );
      return {
        _id:            site._id,
        name:           site.name,
        address:        site.address,
        type:           site.type,
        photo:          site.photo,
        distanceMeters: site.distanceMeters,
        tradeEntry:     trade || null,
        contractorId:   site.contractorInfo?._id || null,
        contractorName: site.contractorInfo?.companyName || null,
      };
    });

    res.json({ results, professionality, hourlyRate: pro.hourlyRate ?? null });
  } catch (err) {
    next(err);
  }
}

// POST /api/trade/jobs/:siteId/apply
export async function applyToJob(req, res, next) {
  try {
    const { siteId } = req.params;
    const { lang = 'en', date } = req.body;

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

    // Upsert: update existing pending application (new date) or create fresh one
    await Application.findOneAndUpdate(
      { tradePro: req.userId, site: siteId },
      { $set: { contractor: site.contractor._id, scheduledDate: date || null, status: 'pending' } },
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

    // Record application as a pending trade message
    await Message.create({
      tradePro:      req.userId,
      site:          siteId,
      contractor:    site.contractor._id,
      requestedDate: date || '',
      status:        'pending',
      senderType:    'trade',
      type:          'availability',
    });

    // Email to contractor
    const locale      = lang === 'es' ? 'es-ES' : 'en-US';
    const contractorEmail = site.contractor?.email;
    const companyName     = site.contractor?.companyName || 'Contractor';

    if (contractorEmail) {
      const subject = lang === 'es'
        ? `Nuevo interesado en "${site.name}" — TradeLink`
        : `New applicant for "${site.name}" — TradeLink`;

      const locale = lang === 'es' ? 'es-ES' : 'en-US';
    const rateLine = pro.hourlyRate
        ? `<p style="margin:4px 0;color:#475569;font-size:14px">💰 $${pro.hourlyRate}/hr</p>`
        : '';
    const dateLine = date
        ? `<p style="margin:4px 0;color:#0369a1;font-size:14px;font-weight:700">📅 ${new Date(date + 'T12:00:00').toLocaleDateString(locale, { weekday:'long', year:'numeric', month:'long', day:'numeric' })}</p>`
        : '';

      const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#f8fafc;padding:24px}</style>
</head><body>
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.08)">
  <div style="background:linear-gradient(135deg,#f59e0b,#0ea5e9);padding:28px;text-align:center">
    <h1 style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-.5px">TradeLink</h1>
    <p style="color:rgba(255,255,255,.85);font-size:13px;margin-top:4px">${lang === 'es' ? 'Nueva solicitud de trabajo' : 'New Job Application'}</p>
  </div>
  <div style="padding:32px">
    <p style="color:#0f172a;font-size:15px;margin-bottom:20px">
      ${lang === 'es' ? `Hola <strong>${companyName}</strong>,` : `Hi <strong>${companyName}</strong>,`}
    </p>
    <p style="color:#475569;font-size:14px;line-height:1.6;margin-bottom:24px">
      ${lang === 'es'
        ? `Un profesional está interesado en trabajar en tu proyecto <strong>"${site.name}"</strong> en TradeLink.`
        : `A trade professional has expressed interest in working on your project <strong>"${site.name}"</strong> on TradeLink.`}
    </p>

    <div style="background:#f0f9ff;border:2px solid #0ea5e9;border-radius:14px;padding:20px;margin-bottom:24px;display:flex;align-items:center;gap:16px">
      ${pro.photo
        ? `<img src="${pro.photo}" alt="${pro.fullName}" style="width:56px;height:56px;border-radius:12px;object-fit:cover;flex-shrink:0;border:2px solid #bae6fd">`
        : `<div style="width:56px;height:56px;border-radius:12px;background:#e0f2fe;display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0">🔧</div>`}
      <div>
        <p style="color:#0f172a;font-size:16px;font-weight:800;margin-bottom:2px">${pro.fullName}</p>
        <p style="color:#0369a1;font-size:13px;font-weight:600">🏗️ ${pro.professionality}</p>
        ${rateLine}
        ${dateLine}
      </div>
    </div>

    <div style="background:#fefce8;border:1.5px solid #fde68a;border-radius:12px;padding:14px;margin-bottom:28px">
      <p style="color:#92400e;font-size:13px;font-weight:700;margin-bottom:4px">📍 ${lang === 'es' ? 'Tu proyecto' : 'Your project'}</p>
      <p style="color:#0f172a;font-size:15px;font-weight:800">${site.name}</p>
      <p style="color:#64748b;font-size:13px;margin-top:2px">${site.address}</p>
    </div>

    <p style="color:#94a3b8;font-size:12px;text-align:center;line-height:1.6">
      ${lang === 'es'
        ? 'Inicia sesión en TradeLink para ver el perfil completo del profesional y contactarlo.'
        : 'Log in to TradeLink to view the full professional profile and get in touch.'}
    </p>
  </div>
  <div style="background:#f8fafc;padding:16px;text-align:center;border-top:1px solid #e2e8f0">
    <p style="color:#94a3b8;font-size:11px">TradeLink · ${lang === 'es' ? 'Conectando profesionales con proyectos' : 'Connecting trade professionals with projects'}</p>
  </div>
</div>
</body></html>`;

      await sendMail({ to: contractorEmail, subject, html });
      console.log(`[applyToJob] Email sent to ${contractorEmail} for site "${site.name}" from ${pro.fullName}`);
    }

    res.json({ ok: true, siteName: site.name, contractorName: companyName });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ duplicate: true });
    }
    next(err);
  }
}


