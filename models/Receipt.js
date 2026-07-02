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
}, { timestamps: true });

export default mongoose.model('Receipt', receiptSchema);
