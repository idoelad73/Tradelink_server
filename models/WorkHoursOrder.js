import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * tradehours_orders collection
 * Created when a trade pro submits actual hours worked for contractor approval.
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
      type: Schema.Types.ObjectId,
      ref:  'Site',
      default: null,
    },
    date: {
      type:     String,   // YYYY-MM-DD
      required: true,
    },
    actual_hours: {
      type:     Number,   // e.g. 7.5 (totalSeconds / 3600, 2 dp)
      required: true,
    },
    order_sum: {
      type:    Number,    // actual_hours * trade pro's hourlyRate at time of submission
      default: 0,
    },
    status: {
      type:    String,
      enum:    ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
  },
  { timestamps: true, collection: 'tradehours_orders' }
);

// Compound: quickly list all orders for a contractor sorted newest first
workHoursOrderSchema.index({ contractor_id: 1, createdAt: -1 });
// Compound: quickly list all orders for a trade pro
workHoursOrderSchema.index({ trade_id: 1, createdAt: -1 });

const WorkHoursOrder = mongoose.model('WorkHoursOrder', workHoursOrderSchema);
export default WorkHoursOrder;
