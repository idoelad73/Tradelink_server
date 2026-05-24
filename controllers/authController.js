import jwt from 'jsonwebtoken';
import TradePro from '../models/TradePro.js';
import Contractor from '../models/Contractor.js';
import { uploadPhoto, uploadDocument } from '../utils/cloudinary.js';

const signToken = (id, type) =>
  jwt.sign({ id, type }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

const sendToken = (user, type, statusCode, res) => {
  const token = signToken(user._id, type);

  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.status(statusCode).json({
    token,
    user: {
      id:   user._id,
      type,
      email: user.email,
      ...(user.fullName    && { fullName: user.fullName }),
      ...(user.companyName && { companyName: user.companyName }),
      photo: user.photo || null,
    },
  });
};

async function maybeUploadPhoto(file) {
  if (!file) return undefined;
  const result = await uploadPhoto(file.buffer);
  return result.secure_url;
}

async function maybeUploadDoc(file, folder) {
  if (!file) return undefined;
  const result = await uploadDocument(file.buffer, folder, file.originalname);
  return result.secure_url;
}

// ── POST /api/auth/register/trade ─────────────────────────────────────────────
export async function registerTrade(req, res, next) {
  try {
    const {
      fullName, email, password, phone, address,
      professionality, locationConsent, latitude, longitude,
      hourlyRate,
    } = req.body;

    const existing = await TradePro.findOne({ email });
    if (existing) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    const files = req.files || {};
    const [photo, licenseDoc, insuranceDoc, cv] = await Promise.all([
      maybeUploadPhoto(files.photo?.[0]),
      maybeUploadDoc(files.licenseDoc?.[0],   'tradelink/licenses'),
      maybeUploadDoc(files.insuranceDoc?.[0], 'tradelink/insurance'),
      maybeUploadDoc(files.cv?.[0],           'tradelink/cvs'),
    ]);

    const consent = locationConsent === 'true' || locationConsent === true;
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    const hasCoords = consent && !isNaN(lat) && !isNaN(lng);

    const user = await TradePro.create({
      fullName, email, password, phone, address,
      professionality,
      hourlyRate: hourlyRate ? parseFloat(hourlyRate) : null,
      photo, licenseDoc, insuranceDoc, cv,
      locationConsent: consent,
      // GeoJSON: [longitude, latitude] — MongoDB standard
      location: {
        type: 'Point',
        coordinates: hasCoords ? [lng, lat] : [0, 0],
      },
    });

    sendToken(user, 'trade', 201, res);
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/login/trade ────────────────────────────────────────────────
export async function loginTrade(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email and password are required' });

    const user = await TradePro.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ message: 'Invalid email or password' });

    await TradePro.findByIdAndUpdate(user._id, {
      isLoggedIn: true,
      lastLogin:  new Date(),
      $inc: { loginCount: 1 },
    });

    sendToken(user, 'trade', 200, res);
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/login/contractor ───────────────────────────────────────────
export async function loginContractor(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email and password are required' });

    const user = await Contractor.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ message: 'Invalid email or password' });

    await Contractor.findByIdAndUpdate(user._id, {
      isLoggedIn: true,
      lastLogin:  new Date(),
      $inc: { loginCount: 1 },
    });

    sendToken(user, 'contractor', 200, res);
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/register/contractor ────────────────────────────────────────
export async function registerContractor(req, res, next) {
  try {
    const { companyName, email, password, phone, address, expertise } = req.body;

    const existing = await Contractor.findOne({ email });
    if (existing) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    const expertiseArr = Array.isArray(expertise)
      ? expertise
      : typeof expertise === 'string'
        ? JSON.parse(expertise)
        : [];

    const user = await Contractor.create({
      companyName, email, password, phone, address,
      expertise: expertiseArr,
    });

    sendToken(user, 'contractor', 201, res);
  } catch (err) {
    next(err);
  }
}
