import Contractor from '../models/Contractor.js';
import Site from '../models/Site.js';
import Application from '../models/Application.js';

// Normalises incoming tradesNeeded — accepts string array OR {name,assigned} object array
function normalizeTrades(raw) {
  const arr = Array.isArray(raw) ? raw : JSON.parse(raw);
  return arr.map((t) =>
    typeof t === 'string'
      ? { name: t, assigned: false, budgetType: null, maxAmount: null, totalHours: null }
      : {
          name:       t.name,
          assigned:   t.assigned   ?? false,
          budgetType: t.budgetType ?? null,
          maxAmount:  t.maxAmount  ?? null,
          totalHours: t.totalHours ?? null,
        }
  );
}
import TradePro from '../models/TradePro.js';
import Message from '../models/Message.js';
import { uploadPhoto } from '../utils/cloudinary.js';
import { geocodeAddress } from '../utils/geocode.js';
import { sendMail } from '../utils/mailer.js';
import jwt from 'jsonwebtoken';

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
      coordinates: coords ? [coords.lng, coords.lat] : [0, 0],
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
    res.json({ sites });
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

// POST /api/contractor/trade-pros/:tradeId/ask-availability
// Sends an availability-request email to the trade professional
export async function askAvailability(req, res, next) {
  try {
    const { date, siteName, siteAddress = '', lang = 'en', siteId } = req.body;
    if (!date) return res.status(400).json({ message: 'date is required' });

    const [pro, contractor] = await Promise.all([
      TradePro.findById(req.params.tradeId).select('fullName email professionality photo'),
      Contractor.findById(req.userId).select('companyName'),
    ]);
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

    const locale      = lang === 'es' ? 'es-ES' : 'en-US';
    const displayDate = new Date(date + 'T12:00:00').toLocaleDateString(locale, {
      year: 'numeric', month: 'long', day: 'numeric',
    });
    const companyName = contractor?.companyName || (lang === 'es' ? 'Un contratista' : 'A contractor');

    const copy = lang === 'es' ? {
      header:   'Solicitud de Disponibilidad',
      greeting: `Estimado/a <strong>${pro.fullName}</strong>`,
      body:     `Nos comunicamos desde <strong>${companyName}</strong> a través de TradeLink. Estamos interesados en sus servicios de <strong>${pro.professionality}</strong> y quisiéramos saber si está disponible el:`,
      siteLabel:'Obra',
      follow:   'Si está disponible en esa fecha, por favor contáctenos para coordinar los detalles del trabajo. Esperamos su respuesta.',
      regards:  'Saludos cordiales',
      footer:   'Este mensaje fue enviado a través de la plataforma TradeLink. Por favor no responda a este correo automático.',
    } : {
      header:   'Availability Request',
      greeting: `Dear <strong>${pro.fullName}</strong>`,
      body:     `We are reaching out from <strong>${companyName}</strong> via TradeLink. We are interested in your <strong>${pro.professionality}</strong> services and would like to know if you are available on:`,
      siteLabel:'Site',
      follow:   'If you are available on this date, please get in touch with us so we can discuss the details of the work required. We look forward to hearing from you.',
      regards:  'Best regards',
      footer:   'This message was sent through the TradeLink platform. Please do not reply to this automated email.',
    };

    const subject = lang === 'es'
      ? `Solicitud de disponibilidad para el ${displayDate} — ${companyName}`
      : `Availability Request for ${displayDate} — ${companyName}`;

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f8fafc;padding:32px;border-radius:16px;">
        <div style="background:linear-gradient(135deg,#0ea5e9,#f59e0b);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
          <h1 style="color:#fff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.5px;">TradeLink</h1>
          <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:13px;">${copy.header}</p>
        </div>
        <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e2e8f0;">
          <p style="color:#334155;font-size:15px;margin:0 0 16px;">${copy.greeting},</p>
          <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 16px;">${copy.body}</p>
          <div style="background:#f0f9ff;border:2px solid #0ea5e9;border-radius:10px;padding:16px;text-align:center;margin:20px 0;">
            <p style="margin:0;font-size:20px;font-weight:800;color:#0369a1;">📅 ${displayDate}</p>
            ${siteName ? `<p style="margin:6px 0 0;font-size:13px;color:#64748b;">${copy.siteLabel}: <strong>${siteName}</strong></p>` : ''}
          </div>
          <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 16px;">${copy.follow}</p>
          <p style="color:#475569;font-size:14px;margin:0;">
            ${copy.regards},<br/>
            <strong>${companyName}</strong><br/>
            <span style="color:#94a3b8;font-size:12px;">via TradeLink</span>
          </p>
        </div>
        <p style="text-align:center;color:#94a3b8;font-size:11px;margin-top:20px;">${copy.footer}</p>
      </div>
    `;

    // Signed token for the one-click approve button (valid 7 days)
    const bookingToken = jwt.sign(
      { tradeId: pro._id.toString(), date, siteName: siteName || '', siteAddress },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    const serverUrl  = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3000}`;
    const approveUrl = `${serverUrl}/api/trade/approve-booking?token=${bookingToken}`;

    const approveBtn = lang === 'es'
      ? `<div style="text-align:center;margin:24px 0">
           <a href="${approveUrl}" style="display:inline-block;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;font-size:15px;font-weight:800;padding:14px 32px;border-radius:12px;text-decoration:none;letter-spacing:-.2px">
             ✅ Aprobado para el trabajo
           </a>
           <p style="color:#94a3b8;font-size:11px;margin-top:10px">Este enlace es válido por 7 días</p>
         </div>`
      : `<div style="text-align:center;margin:24px 0">
           <a href="${approveUrl}" style="display:inline-block;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;font-size:15px;font-weight:800;padding:14px 32px;border-radius:12px;text-decoration:none;letter-spacing:-.2px">
             ✅ Approved for the Job
           </a>
           <p style="color:#94a3b8;font-size:11px;margin-top:10px">This link is valid for 7 days</p>
         </div>`;

    const htmlWithBtn = html.replace(
      '<p style="text-align:center;color:#94a3b8',
      approveBtn + '<p style="text-align:center;color:#94a3b8'
    );

    await sendMail({ to: pro.email, subject, html: htmlWithBtn });

    // Create message record + increment counter
    if (siteId) {
      await Message.create({
        tradePro:      req.params.tradeId,
        site:          siteId,
        contractor:    req.userId,
        requestedDate: date,
        status:        'pending',
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

// GET /api/contractor/applications
export async function getApplications(req, res, next) {
  try {
    const siteIds = await Site.find({ contractor: req.userId }).distinct('_id');
    const applications = await Application.find({ site: { $in: siteIds } })
      .populate('tradePro', 'fullName professionality photo hourlyRate')
      .populate('site',     'name address type photo tradesNeeded')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ applications });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/contractor/applications/:id/approve
export async function approveApplication(req, res, next) {
  try {
    const { scheduledDate } = req.body; // YYYY-MM-DD

    const app = await Application.findById(req.params.id)
      .populate('tradePro', 'professionality')
      .populate('site',     'name address tradesNeeded contractor');
    if (!app) return res.status(404).json({ message: 'Application not found' });

    if (String(app.site.contractor) !== String(req.userId))
      return res.status(403).json({ message: 'Not authorized' });

    if (app.status === 'accepted') return res.json({ message: 'Already approved' });

    app.status = 'accepted';
    // Use contractor-provided date if given, otherwise keep trade pro's proposed date
    if (scheduledDate) app.scheduledDate = scheduledDate;
    await app.save();

    // Mark the matching trade as assigned in the site
    await Site.updateOne(
      {
        _id: app.site._id,
        'tradesNeeded.name': { $regex: new RegExp(`^${app.tradePro.professionality}$`, 'i') },
      },
      { $set: { 'tradesNeeded.$.assigned': true } }
    );

    // Upgrade the 'order' booking to 'booked' (turns calendar from orange → dark red)
    await TradePro.updateOne(
      { _id: app.tradePro._id, 'bookings.siteId': app.site._id, 'bookings.status': 'order' },
      { $set: { 'bookings.$.status': 'booked' } }
    );

    res.json({ ok: true });
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

    const { trade, distance = '25', unit = 'mi', maxRate } = req.query;
    if (!trade) return res.status(400).json({ message: 'trade query param is required' });

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
        location: { type: 'Point', coordinates: [lng, lat] },
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

    const pipeline = [
      {
        $geoNear: {
          near:          { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distance',
          maxDistance:   meters,
          query:         { professionality: trade },
          spherical:     true,
        },
      },
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

    // Sort: available today first, then by hourlyRate ascending
    pipeline.push(
      {
        $addFields: {
          isAvailableToday: {
            $not: [{ $in: [todayKey, { $ifNull: ['$busyDays', []] }] }],
          },
        },
      },
      { $sort: { isAvailableToday: -1, hourlyRate: 1 } },
      {
        $project: {
          fullName:        1,
          phone:           1,
          address:         1,
          professionality: 1,
          photo:           1,
          hourlyRate:      1,
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
    res.json({ results: sanitised, total: sanitised.length });
  } catch (err) {
    next(err);
  }
}
