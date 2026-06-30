import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

const { Schema } = mongoose;

const contractorSchema = new Schema(
  {
    companyName: { type: String, required: true, trim: true },
    email:       { type: String, required: true, unique: true, lowercase: true, trim: true },
    password:    { type: String, required: true, select: false },
    phone:       { type: String, required: true },
    address:     { type: String, required: true },
    expertise:   [{ type: String }],

    // ── Sites ─────────────────────────────────────────────────
    sites: [{ type: Schema.Types.ObjectId, ref: 'Site' }],

    // ── Session tracking ─────────────────────────────────────
    isLoggedIn:  { type: Boolean, default: false },
    lastLogin:   { type: Date,    default: null  },
    loginCount:  { type: Number,  default: 0     },

    // ── Stripe — store only Stripe IDs, never raw card data ──
    stripeCustomerId:            { type: String, default: null },
    stripeDefaultPaymentMethod:  { type: String, default: null }, // saved from last deposit for off-session overage charges
  },
  { timestamps: true }
);

contractorSchema.index({ expertise: 1 });

contractorSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

contractorSchema.methods.comparePassword = function (plaintext) {
  return bcrypt.compare(plaintext, this.password);
};

const Contractor = mongoose.model('Contractor', contractorSchema);
export default Contractor;
