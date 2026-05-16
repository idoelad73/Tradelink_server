import TradePro from '../models/TradePro.js';

// GET /api/trade/me
export async function getMe(req, res, next) {
  try {
    const trade = await TradePro.findById(req.userId);
    res.json({ trade });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/trade/me
export async function updateMe(req, res, next) {
  try {
    const { fullName, phone, address, professionality } = req.body;
    const updates = {};
    if (fullName        !== undefined) updates.fullName        = fullName;
    if (phone           !== undefined) updates.phone           = phone;
    if (address         !== undefined) updates.address         = address;
    if (professionality !== undefined) updates.professionality = professionality;

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
