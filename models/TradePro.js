import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

const { Schema } = mongoose;

const tradeProSchema = new Schema(
  {
    fullName:        { type: String, required: true, trim: true },
    email:           { type: String, required: true, unique: true, lowercase: true, trim: true },
    password:        { type: String, required: true, select: false },
    phone:           { type: String, required: true },
    address:         { type: String, required: true },
    professionality: { type: String, required: true },

    hourlyRate:   { type: Number, default: null }, // $/hr — optional

    photo:        { type: String, default: null }, // Cloudinary URL
    licenseDoc:   { type: String, default: null }, // Cloudinary URL
    insuranceDoc: { type: String, default: null }, // Cloudinary URL
    cv:           { type: String, default: null }, // Cloudinary URL

    locationConsent: { type: Boolean, default: false },
    location: {
      type:        { type: String, enum: ['Point'], default: 'Point' },
      // Use 0.0 literals so MongoDB stores Double (float64), not Int32
      coordinates: { type: [Number], default: [0.0, 0.0] },
    },

    // ── Availability schedule ─────────────────────────────────
    // Personal off days — "YYYY-MM-DD" strings (vacation, sickness, etc.)
    busyDays: [{ type: String }],

    // Job bookings — 'order' when applied, 'booked' after contractor approves
    bookings: [{
      siteId:       { type: Schema.Types.ObjectId, ref: 'Site',       default: null },
      contractorId: { type: Schema.Types.ObjectId, ref: 'Contractor', default: null }, // set for direct-search bookings (no site)
      siteName:     { type: String, default: '' },
      siteAddress:  { type: String, default: '' },
      booking_date: { type: String, default: null }, // primary date YYYY-MM-DD — used for availability search
      dates:        [{ type: String }],              // YYYY-MM-DD for every working day in range
      status:       { type: String, enum: ['order', 'booked'], default: 'booked' },
      totalHours:   { type: Number, default: null },
      workers_no:   { type: Number, default: null },
    }],

    // ── Portfolio photos (up to 5 Cloudinary URLs) ───────────────────────────────
    portfolioPhotos: [{ type: String }],

    // ── Weekly working hours ──────────────────────────────────────────────────────
    workingHours: {
      monday:    { active: { type: Boolean, default: false }, start: { type: String, default: '08:00' }, end: { type: String, default: '17:00' } },
      tuesday:   { active: { type: Boolean, default: false }, start: { type: String, default: '08:00' }, end: { type: String, default: '17:00' } },
      wednesday: { active: { type: Boolean, default: false }, start: { type: String, default: '08:00' }, end: { type: String, default: '17:00' } },
      thursday:  { active: { type: Boolean, default: false }, start: { type: String, default: '08:00' }, end: { type: String, default: '17:00' } },
      friday:    { active: { type: Boolean, default: false }, start: { type: String, default: '08:00' }, end: { type: String, default: '17:00' } },
      saturday:  { active: { type: Boolean, default: false }, start: { type: String, default: '08:00' }, end: { type: String, default: '17:00' } },
      sunday:    { active: { type: Boolean, default: false }, start: { type: String, default: '08:00' }, end: { type: String, default: '17:00' } },
    },

    // ── Trade grades — denormalized averages updated on every new grade ──────────
    avgGrade:   { type: Number, default: null },  // 1.0 – 5.0, null = no grades yet
    gradeCount: { type: Number, default: 0    },  // total number of grades received

    // ── Stripe Connect — store only Stripe IDs, never card data ─
    stripeAccountId: { type: String,  default: null  }, // Express connected account
    stripeOnboarded: { type: Boolean, default: false }, // true after charges_enabled

    // ── Session tracking ─────────────────────────────────────
    isLoggedIn:           { type: Boolean, default: false },
    lastLogin:            { type: Date,    default: null  },
    loginCount:           { type: Number,  default: 0     },
    availabilityMessages: { type: Number,  default: 0     },

    // ── Password reset ────────────────────────────────────
    passwordResetTokenHash: { type: String, default: null, select: false },
    passwordResetExpiresAt: { type: Date,   default: null },
  },
  { timestamps: true }
);

tradeProSchema.index({ location: '2dsphere' });
tradeProSchema.index({ professionality: 1 });

tradeProSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// ── Auto-fix coordinate BSON types to Double after every save ─────────────────
// Mongoose schema casting calls .valueOf() on BSON Double objects, stripping the
// type hint and letting the driver store whole numbers as Int32.
// This post-save hook writes coordinates back via the raw collection API so they
// are always stored as Float64 (Double) — required for 2dsphere geo-queries.
//
// [0, 0] special case: MongoDB's numeric-equality no-op check treats Int32(0)
// and Double(0.0) as the same value. We use a two-step sentinel write to force
// the BSON type change.
tradeProSchema.post('save', async function () {
  try {
    const { Double } = mongoose.mongo;
    const col = this.constructor.collection;
    const [lng, lat] = this.location?.coordinates ?? [0, 0];

    if (lng === 0 && lat === 0) {
      // Two-step: value must change for MongoDB to write → sentinel → back to 0.0 Double
      await col.updateOne({ _id: this._id }, {
        $set: { 'location.coordinates': [new Double(0.1), new Double(0.1)] },
      });
      await col.updateOne({ _id: this._id }, {
        $set: { 'location.coordinates': [new Double(0), new Double(0)] },
      });
    } else {
      // Non-zero: direct write — raw API bypasses Mongoose casting
      await col.updateOne({ _id: this._id }, {
        $set: { 'location.coordinates': [new Double(lng), new Double(lat)] },
      });
    }
  } catch {
    // Non-fatal — geo queries still work with Int32 for non-zero coords
  }
});

tradeProSchema.methods.comparePassword = function (plaintext) {
  return bcrypt.compare(plaintext, this.password);
};

const TradePro = mongoose.model('TradePro', tradeProSchema);
export default TradePro;
