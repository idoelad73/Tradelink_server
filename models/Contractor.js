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

    // ── Access level ─────────────────────────────────────────
    // 'user'  → regular contractor (default)
    // 'admin' → may sign in to the TradeLink admin dashboard
    user_type:   { type: String, enum: ['user', 'admin'], default: 'user' },

    // ── Sites ─────────────────────────────────────────────────
    sites: [{ type: Schema.Types.ObjectId, ref: 'Site' }],

    // ── Session tracking ─────────────────────────────────────
    isLoggedIn:  { type: Boolean, default: false },
    lastLogin:   { type: Date,    default: null  },
    loginCount:  { type: Number,  default: 0     },

    // ── Ratings (from trade pros grading this contractor) ────
    avgGrade:   { type: Number, default: null },
    gradeCount: { type: Number, default: 0    },

    // ── Stripe — store only Stripe IDs, never raw card data ──
    stripeCustomerId:            { type: String, default: null },
    stripeDefaultPaymentMethod:  { type: String, default: null },

    // ── Password reset ────────────────────────────────────
    passwordResetTokenHash: { type: String, default: null, select: false },
    passwordResetExpiresAt: { type: Date,   default: null },
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
