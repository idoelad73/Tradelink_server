import mongoose from 'mongoose';

const { Schema } = mongoose;

// One trade slot on a project.
const tradeSlotSchema = new Schema(
  {
    name:       { type: String, required: true, trim: true },
    assigned:   { type: Boolean, default: false },
    tradeProId: { type: Schema.Types.ObjectId, ref: 'TradePro', default: null },
    budgetType:      { type: String, enum: ['amount', 'hours'], default: null },
    maxAmount:       { type: Number, default: null },
    totalHours:      { type: Number, default: null },
    // totalWorkingHrs = totalHours × workers_no (hours-budget only)
    totalWorkingHrs: { type: Number, default: null },
    requiredDate:    { type: String, default: null }, // YYYY-MM-DD
    workers_no:      { type: Number, default: null }, // number of workers needed
    // Contractor's free-text explanation of how this trade's rate/budget was
    // set. Written alongside the budget and shown read-only to trade pros.
    rateComment:     { type: String, default: '', trim: true, maxlength: 1000 },
  },
  { _id: false }
);

// A trade name identifies its slot everywhere — deposits ("site::tradeName"),
// worker counts, booking lookups and the rate-explanation mirror — and those
// lookups are case-insensitive. Two slots with the same name (in any case)
// would silently collide, so they are rejected. Several workers for one trade
// are expressed with workers_no, not duplicate slots.
const normTrade = (name) => String(name ?? '').trim().toLowerCase();

export function findDuplicateTradeName(slots) {
  const seen = new Set();
  for (const s of slots ?? []) {
    const key = normTrade(s?.name);
    if (!key) continue;
    if (seen.has(key)) return String(s.name).trim();
    seen.add(key);
  }
  return null;
}

const siteSchema = new Schema(
  {
    contractor: {
      type: Schema.Types.ObjectId,
      ref:  'Contractor',
      required: true,
      index: true,
    },
    name:    { type: String, required: true, trim: true },
    type:    { type: String, enum: ['residential', 'commercial'], required: true },
    address: { type: String, required: true, trim: true },

    // Trades needed at this site — each entry tracks name + whether a pro is assigned
    tradesNeeded: {
      type: [tradeSlotSchema],
      validate: {
        validator: (slots) => findDuplicateTradeName(slots) === null,
        message:   'Each trade can only appear once per project',
      },
    },

    photo:  { type: String, default: null }, // Cloudinary URL
    status: {
      type:    String,
      enum:    ['active', 'completed', 'on_hold'],
      default: 'active',
    },

    // Optional notes or description for the site
    notes: { type: String, trim: true, default: '' },

    // GeoJSON point — populated by geocoding the address on create
    location: {
      type:        { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0.0, 0.0] }, // [lng, lat] — Double, not Int32
    },
  },
  { timestamps: true }
);

// Compound index: quickly fetch all sites for a contractor sorted by newest
siteSchema.index({ contractor: 1, createdAt: -1 });
siteSchema.index({ location: '2dsphere' });

const Site = mongoose.model('Site', siteSchema);
export default Site;
