import mongoose from 'mongoose';

const receiptSchema = new mongoose.Schema({
  receipt_number:        { type: String, required: true, unique: true },
  receipt_type:          { type: String, enum: ['contractor', 'trade'], required: true },
  order_id:              { type: mongoose.Schema.Types.ObjectId, ref: 'WorkHoursOrder' },
  contractor_id:         { type: mongoose.Schema.Types.ObjectId, ref: 'Contractor' },
  trade_id:              { type: mongoose.Schema.Types.ObjectId, ref: 'TradePro' },
  site_id:               { type: mongoose.Schema.Types.ObjectId, ref: 'Site' },
  // Denormalized snapshots — immune to future document changes
  contractor_name:       String,
  trade_name:            String,
  trade_professionality: String,
  site_name:             String,
  site_address:          String,
  date:                  String,
  actual_hours:          Number,
  workers_no:            Number,
  hourly_rate:           Number,
  order_sum:             Number,
  fee_sum:               Number,
  payment_sum:           Number,
  paymentStatus:         { type: String, default: 'paid' },

  // ── Delivery tracking ──────────────────────────────────────────────────────
  // A receipt number is allocated because the money moved, so the document is
  // genuinely owed — but that says nothing about whether it reached anyone.
  // Recording the outcome keeps the ledger honest and gives a retry something
  // to select on, instead of a row that silently implies "sent".
  emailedAt:     { type: Date,    default: null },  // null = never delivered
  deliveryError: { type: String,  default: null },  // last failure reason
  pdfAttached:   { type: Boolean, default: false }, // false = sent without the PDF
}, { timestamps: true });

// Receipts still owed to someone — drives any resend/repair pass.
receiptSchema.index({ emailedAt: 1, createdAt: -1 });

export default mongoose.model('Receipt', receiptSchema);
