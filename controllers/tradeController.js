import TradePro from '../models/TradePro.js';
import Message from '../models/Message.js';
import jwt from 'jsonwebtoken';
import { uploadPhoto } from '../utils/cloudinary.js';

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

    const alreadyBooked = pro.bookings?.some((b) => b.date === date && b.siteName === siteName);
    if (!alreadyBooked) {
      await TradePro.findByIdAndUpdate(tradeId, {
        $push: { bookings: { date, siteName, siteAddress } },
      });
      console.log(`[approveBooking] ${pro.fullName} confirmed for "${siteName}" on ${date}`);
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

    // Push booking into TradePro bookings (same format as email-link approval)
    const alreadyBooked = await TradePro.findOne({
      _id: req.userId,
      'bookings.date':     msg.requestedDate,
      'bookings.siteName': msg.site.name,
    });
    if (!alreadyBooked) {
      await TradePro.findByIdAndUpdate(req.userId, {
        $push: { bookings: {
          date:        msg.requestedDate,
          siteName:    msg.site.name,
          siteAddress: msg.site.address,
        }},
      });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
