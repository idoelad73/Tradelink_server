import mongoose from 'mongoose';
const { Schema } = mongoose;

/**
 * Unified "JobRequest / Message" collection.
 *
 * type        | senderType  | status             | meaning
 * ------------|-------------|--------------------|-----------------------------------------
 * application | trade       | pending/approved   | Trade pro applied to work on a site
 * availability| contractor  | pending            | Contractor asked if trade is available
 * approval    | contractor  | approved           | Contractor approved the trade
 * reschedule  | trade       | pending            | Trade pro asked to change booked date
 * payment     | trade       | pending            | Trade submitted hours (no WorkHoursOrder yet)
 * payment     | contractor  | approved           | Contractor approved → WorkHoursOrder created
 * payment     | contractor  | rejected           | Contractor rejected → snapshot in text field
 */
const messageSchema = new Schema(
  {
    tradePro:      { type: Schema.Types.ObjectId, ref: 'TradePro',   required: true, index: true },
    site:          { type: Schema.Types.ObjectId, ref: 'Site',       default: null },
    contractor:    { type: Schema.Types.ObjectId, ref: 'Contractor', required: true },
    requestedDate: { type: String, default: '' },   // YYYY-MM-DD
    text:          { type: String, default: '' },
    tradeName:      { type: String,  default: '' }, // e.g. 'Painter' — which trade slot this fills
    workersOffered: { type: Number,  default: 1  }, // how many workers this TradePro is offering

    status: {
      type:    String,
      enum:    ['pending', 'approved', 'accepted', 'rejected'],
      default: 'pending',
    },
    type: {
      type:     String,
      enum:     ['application', 'availability', 'approval', 'reschedule', 'payment'],
      required: true,
    },
    senderType: {
      type:     String,
      enum:     ['trade', 'contractor'],
      required: true,
    },
  },
  { timestamps: true }
);

messageSchema.index({ tradePro: 1, contractor: 1, createdAt: 1 });

// Unique: one application per trade pro per site
messageSchema.index(
  { tradePro: 1, site: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: 'application' } }
);

const Message = mongoose.model('Message', messageSchema);
export default Message;
