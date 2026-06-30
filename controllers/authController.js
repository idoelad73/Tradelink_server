import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import TradePro from '../models/TradePro.js';
import Contractor from '../models/Contractor.js';
import { uploadPhoto, uploadDocument } from '../utils/cloudinary.js';
import stripe from '../utils/stripe.js';
import { sendMail } from '../utils/mailer.js';

// Force BSON Double so MongoDB stores as Float64, not Int32
const toDouble = (v) => new mongoose.mongo.Double(parseFloat(v));

const signToken = (id, type) =>
  jwt.sign({ id, type }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

const sendToken = (user, type, statusCode, res, extra = {}) => {
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
    ...extra,
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
      city, state, zip,
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

    // ── Stripe Connect — Custom account (no redirect, KYC via API) ──────────
    // bankToken   = btok_... created by Stripe.js — raw account numbers never reach here
    // dob         = YYYY-MM-DD date of birth
    // ssnLast4    = last 4 digits of SSN — passed to Stripe, NOT stored in DB
    // holderType  = 'individual' | 'company'
    const { bankToken, dob, ssnLast4, holderType } = req.body;

    // Map trade profession → Stripe MCC (Merchant Category Code)
    // This avoids asking the user for a code they've never heard of
    const MCC_MAP = {
      'Electrician':              '1731',
      'Plumber':                  '1711',
      'HVAC Technician':          '1711',
      'Carpenter':                '1750',
      'Painter':                  '1731',
      'Roofer':                   '1761',
      'Mason / Bricklayer':       '1741',
      'Flooring Specialist':      '1750',
      'Tile Setter':              '1750',
      'Welder':                   '7389',
      'Landscaper':               '0782',
      'Pest Control':             '7342',
      'Locksmith':                '7251',
      'Glazier / Window Installer':'1750',
      'Drywall / Plasterer':      '1750',
      'Insulation Specialist':    '1711',
      'Concrete & Foundation':    '1771',
      'Pool & Spa Technician':    '7389',
      'Solar Panel Installer':    '1731',
      'Garage Door Specialist':   '7699',
      'Handyman':                 '1520',
      'Demolition Contractor':    '1520',
    };
    const mcc = MCC_MAP[professionality] ?? '1520'; // default: general contractor
    let stripeAccountId = null;
    let stripeOnboarded = false;

    console.log(`\n[Register] Trade: ${email}`);
    console.log(`[Register] bankToken  : ${bankToken  ? bankToken.substring(0, 12) + '...' : 'NONE'}`);
    console.log(`[Register] dob        : ${dob        || 'NONE'}`);
    console.log(`[Register] ssnLast4   : ${ssnLast4   ? '****' : 'NONE'}`);
    console.log(`[Register] holderType : ${holderType || 'NONE'}`);

    if (bankToken) {
      try {
        // Parse name into first / last for Stripe individual object
        const nameParts = fullName.trim().split(/\s+/);
        const firstName = nameParts[0];
        const lastName  = nameParts.slice(1).join(' ') || nameParts[0];

        // Parse DOB from YYYY-MM-DD
        const [dobYear, dobMonth, dobDay] = (dob || '').split('-').map(Number);
        const hasDob = dobYear && dobMonth && dobDay;

        const rawUrl = process.env.CLIENT_URL || '';
        // Stripe rejects localhost URLs — use production URL or a valid placeholder
        const isLocalhost = rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1');
        const businessUrl = isLocalhost
          ? (process.env.STRIPE_BUSINESS_URL || 'https://tradelink.app')
          : rawUrl;

        const accountData = {
          type:          'custom',
          country:       'US',
          email,
          capabilities: {
            card_payments: { requested: true },
            transfers:     { requested: true },
          },
          business_type: holderType === 'company' ? 'company' : 'individual',
          business_profile: {
            mcc,
            url: businessUrl,
          },
          // Accept Stripe's Connected Account Agreement on behalf of the user
          // (user checked the checkbox in the registration form)
          tos_acceptance: {
            date: Math.floor(Date.now() / 1000),
            ip:   req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '127.0.0.1',
          },
          metadata: { email },
        };

        // Build structured address (required by Stripe)
        const stripeAddress = {
          line1:       address    || '',
          city:        city       || '',
          state:       (state     || '').toUpperCase(),
          postal_code: zip        || '',
          country:     'US',
        };

        if (holderType === 'company') {
          accountData.company = {
            name:    fullName,
            address: stripeAddress,
          };
        } else {
          accountData.individual = {
            first_name: firstName,
            last_name:  lastName,
            email,
            ...(phone   && { phone }),
            address: stripeAddress,
            ...(hasDob  && { dob: { day: dobDay, month: dobMonth, year: dobYear } }),
            ...(ssnLast4 && { ssn_last_4: ssnLast4 }),
          };
        }

        // 1. Create Custom connected account with full KYC data
        console.log(`[Stripe] Creating Custom account (${holderType || 'individual'}) for ${email}...`);
        const account = await stripe.accounts.create(accountData);
        stripeAccountId = account.id;
        const due = account.requirements?.currently_due ?? [];
        console.log(`[Stripe] ✅ Custom account created: ${stripeAccountId}`);
        console.log(`[Stripe]    Requirements due: ${due.length ? due.join(', ') : 'none'}`);

        // 2. Attach tokenized bank account as external payout account
        console.log(`[Stripe] Attaching bank token ${bankToken.substring(0, 12)}...`);
        const extAcct = await stripe.accounts.createExternalAccount(stripeAccountId, {
          external_account: bankToken,
        });
        console.log(`[Stripe] ✅ Bank attached: ${extAcct.id} (${extAcct.bank_name ?? 'bank'} ****${extAcct.last4})`);

        // 3. Re-fetch account after bank attach — external_account was the last requirement
        const updatedAccount = await stripe.accounts.retrieve(stripeAccountId);
        const stillDue = updatedAccount.requirements?.currently_due ?? [];
        console.log(`[Stripe] Post-attach requirements due: ${stillDue.length ? stillDue.join(', ') : 'none ✅'}`);

        if (updatedAccount.charges_enabled && updatedAccount.details_submitted) {
          stripeOnboarded = true;
          console.log(`[Stripe] ✅ charges_enabled — account ready for payouts!`);
        } else {
          console.log(`[Stripe] ⏳ Stripe still verifying — will update via account.updated webhook`);
          console.log(`[Stripe]    charges_enabled  : ${updatedAccount.charges_enabled}`);
          console.log(`[Stripe]    details_submitted: ${updatedAccount.details_submitted}`);
        }

      } catch (stripeErr) {
        console.error(`\n[Stripe] ❌ Setup failed for ${email}`);
        console.error(`[Stripe]    Code   : ${stripeErr.code    ?? 'n/a'}`);
        console.error(`[Stripe]    Type   : ${stripeErr.type    ?? 'n/a'}`);
        console.error(`[Stripe]    Param  : ${stripeErr.param   ?? 'n/a'}`);
        console.error(`[Stripe]    Message: ${stripeErr.message}`);
        // Don't block registration — TradePro can connect bank later via dashboard
      }
    } else {
      console.log(`[Register] No bankToken — skipping Stripe Connect setup`);
    }

    const user = await TradePro.create({
      fullName, email, password, phone, address,
      professionality,
      hourlyRate: hourlyRate ? parseFloat(hourlyRate) : null,
      photo, licenseDoc, insuranceDoc, cv,
      locationConsent: consent,
      location: {
        type: 'Point',
        // Mongoose schema casting will strip the BSON Double wrapper via .valueOf(),
        // so coordinates are stored as Int32 here. We fix them below with a raw update.
        coordinates: hasCoords ? [parseFloat(lng), parseFloat(lat)] : [0, 0],
      },
      stripeAccountId,
      stripeOnboarded,
    });

    // Post-create: force coordinate BSON type to Double using raw collection API.
    // Bypass Mongoose schema casting which strips the Double wrapper.
    // Note: MongoDB numeric equality means [0,0] Int32 → [0.0,0.0] Double is a no-op —
    // those are placeholder coords anyway and don't affect 2dsphere queries.
    if (hasCoords) {
      const { Double } = mongoose.mongo;
      await TradePro.collection.updateOne(
        { _id: user._id },
        { $set: {
          'location.coordinates': [new Double(parseFloat(lng)), new Double(parseFloat(lat))],
        }}
      );
    }

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

// ── POST /api/auth/forgot-password ────────────────────────────────────────────
export async function forgotPassword(req, res, next) {
  const GENERIC = { message: "If an account with that email exists, we've sent a password reset link." };
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ message: 'Email is required.' });

    // Search both collections — never reveal which (or whether) an account exists
    let user  = await TradePro.findOne({ email });
    let Model = TradePro;
    if (!user) {
      user  = await Contractor.findOne({ email });
      Model = Contractor;
    }

    if (!user) return res.status(200).json(GENERIC);

    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    await Model.findByIdAndUpdate(user._id, {
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min
    });

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const resetLink = `${clientUrl}/reset-password?token=${rawToken}`;
    const name      = user.fullName || user.companyName || 'User';

    const subject = 'TradeLink — Reset Your Password';
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#f8fafc;padding:24px}</style>
</head><body>
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.08)">
  <div style="background:linear-gradient(135deg,#22c55e,#0ea5e9);padding:28px;text-align:center">
    <h1 style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-.5px">TradeLink</h1>
    <p style="color:rgba(255,255,255,.85);font-size:13px;margin-top:4px">Password Reset Request</p>
  </div>
  <div style="padding:32px">
    <p style="color:#0f172a;font-size:15px;margin-bottom:6px">Hi <strong>${name}</strong>,</p>
    <p style="color:#475569;font-size:14px;line-height:1.6;margin-bottom:28px">
      We received a request to reset your TradeLink password. Click the button below to choose a new password.
      This link expires in <strong>30 minutes</strong>.
    </p>

    <div style="text-align:center;margin-bottom:28px">
      <a href="${resetLink}"
         style="display:inline-block;background:linear-gradient(135deg,#22c55e,#0ea5e9);color:#fff;font-weight:700;font-size:15px;padding:14px 32px;border-radius:12px;text-decoration:none;letter-spacing:-.2px">
        Reset My Password
      </a>
    </div>

    <p style="color:#64748b;font-size:12px;line-height:1.6;margin-bottom:8px">
      If the button doesn't work, copy and paste this link into your browser:
    </p>
    <p style="word-break:break-all;color:#0ea5e9;font-size:12px;margin-bottom:24px">${resetLink}</p>

    <p style="color:#94a3b8;font-size:12px;line-height:1.6">
      If you didn't request a password reset, you can safely ignore this email — your password will not change.
    </p>
  </div>
  <div style="background:#f8fafc;padding:16px;text-align:center;border-top:1px solid #e2e8f0">
    <p style="color:#94a3b8;font-size:11px">TradeLink · Connecting trade professionals with projects</p>
  </div>
</div>
</body></html>`;

    await sendMail({ to: user.email, subject, html });

    return res.status(200).json(GENERIC);
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
export async function resetPassword(req, res, next) {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ message: 'Token and new password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    }

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const now       = new Date();

    // Search both collections for a valid (non-expired) matching hash
    let user  = await TradePro.findOne({ passwordResetTokenHash: tokenHash, passwordResetExpiresAt: { $gt: now } });
    let Model = TradePro;
    if (!user) {
      user  = await Contractor.findOne({ passwordResetTokenHash: tokenHash, passwordResetExpiresAt: { $gt: now } });
      Model = Contractor;
    }

    if (!user) {
      return res.status(400).json({ message: 'Reset link is invalid or has expired.' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    await Model.findByIdAndUpdate(user._id, {
      password:               hashedPassword,
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
    });

    return res.status(200).json({ message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    next(err);
  }
}
