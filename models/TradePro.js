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

    photo:        { type: String, default: null }, // Cloudinary URL
    licenseDoc:   { type: String, default: null }, // Cloudinary URL
    insuranceDoc: { type: String, default: null }, // Cloudinary URL
    cv:           { type: String, default: null }, // Cloudinary URL

    locationConsent: { type: Boolean, default: false },
    location: {
      type:        { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] },
    },

    // ── Session tracking ─────────────────────────────────────
    isLoggedIn:  { type: Boolean, default: false },
    lastLogin:   { type: Date,    default: null  },
    loginCount:  { type: Number,  default: 0     },
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

tradeProSchema.methods.comparePassword = function (plaintext) {
  return bcrypt.compare(plaintext, this.password);
};

const TradePro = mongoose.model('TradePro', tradeProSchema);
export default TradePro;
