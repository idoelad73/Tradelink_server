import jwt from 'jsonwebtoken';
import TradePro from '../models/TradePro.js';
import Contractor from '../models/Contractor.js';
import { uploadPhoto, uploadDocument } from '../utils/cloudinary.js';
import stripe from '../utils/stripe.js';

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
        coordinates: hasCoords ? [parseFloat(lng), parseFloat(lat)] : [0.0, 0.0],
      },
      stripeAccountId,
      stripeOnboarded,
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
