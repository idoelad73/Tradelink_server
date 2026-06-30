import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * tradehours_orders collection
 *
 * order_sum is computed by the pre-save hook: actual_hours × hourly_rate.
 * hourly_rate is written by the controller (fetched from TradePro at submit time).
 *
 * GET /payment-approvals always re-enriches from the *current* TradePro.hourlyRate
 * so the displayed amount stays in sync if the rate changes after submission.
 *
 * At approval time the controller locks in both hourly_rate + order_sum via
 * findByIdAndUpdate (bypasses the hook intentionally) so the frozen amount
 * is preserved in the record regardless of future rate changes.
 */
const workHoursOrderSchema = new Schema(
  {
    contractor_id: {
      type:     Schema.Types.ObjectId,
      ref:      'Contractor',
      required: true,
      index:    true,
    },
    trade_id: {
      type:     Schema.Types.ObjectId,
      ref:      'TradePro',
      required: true,
      index:    true,
    },
    site_id: {
      type:    Schema.Types.ObjectId,
      ref:     'Site',
      default: null,
    },
    date: {
      type:     String,   // YYYY-MM-DD
      required: true,
    },
    actual_hours: {
      type:     Number,   // totalSeconds / 3600, rounded to 2 dp
      required: true,
    },
    hourly_rate: {
      type:    Number,    // TradePro.hourlyRate at the time this record was last enriched
      default: null,
    },
    workers_no: {
      type:    Number,    // number of workers the trade pro brought (from booking)
      default: 1,
    },
    order_sum: {
      type:    Number,    // actual_hours × hourly_rate × workers_no — set by controller
      default: 0,
    },
    status: {
      type:    String,
      enum:    ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    // ── Stripe payment tracking ──────────────────────────────────────────────
    stripePaymentIntentId: { type: String, default: null }, // deposit PI that was captured
    stripeTransferId:      { type: String, default: null }, // transfer to trade pro's account
    paymentStatus: {
      type:    String,
      enum:    ['unpaid', 'pending', 'paid', 'failed'],
      default: 'unpaid',
    },
    // Set when payment succeeds (webhook):
    payment_sum: { type: Number, default: null }, // amount TradePro receives (order_sum - fee)
    fee_sum:     { type: Number, default: null }, // platform commission amount
    receiptSent: { type: Boolean, default: false }, // true once receipt email sent to contractor
  },
  { timestamps: true, collection: 'tradehours_orders' }
);

workHoursOrderSchema.index({ contractor_id: 1, createdAt: -1 });
workHoursOrderSchema.index({ trade_id: 1,     createdAt: -1 });

/**
 * Pre-save hook — synchronous (no async, uses next callback).
 * This is the ONLY safe pattern that guarantees `this.*` mutations
 * are persisted before Mongoose writes to MongoDB.
 * Recalculates order_sum every time a document is created or saved.
 */
workHoursOrderSchema.pre('save', function (next) {
  const hours   = this.actual_hours;
  const rate    = this.hourly_rate;
  const workers = this.workers_no || 1;
  if (hours != null && rate != null) {
    // Full team cost: hours × rate × workers
    this.order_sum = parseFloat((hours * rate * workers).toFixed(2));
  } else {
    this.order_sum = 0;
  }
  next();
});

const WorkHoursOrder = mongoose.model('WorkHoursOrder', workHoursOrderSchema);
export default WorkHoursOrder;
