import mongoose from 'mongoose';
const { Schema } = mongoose;

/**
 * Unified "JobRequest / Message" collection.
 *
 * type        | senderType  | meaning
 * ------------|-------------|----------------------------------------------
 * application | trade       | Trade pro applied to work on a site
 * availability| contractor  | Contractor asked if trade is available on a date
 * approval    | contractor  | Contractor approved (via application or availability)
 * reschedule  | trade       | Trade pro asked to change their booked date
 */
const messageSchema = new Schema(
  {
    tradePro:      { type: Schema.Types.ObjectId, ref: 'TradePro',   required: true, index: true },
    site:          { type: Schema.Types.ObjectId, ref: 'Site',       required: true },
    contractor:    { type: Schema.Types.ObjectId, ref: 'Contractor', required: true },
    requestedDate: { type: String, default: '' },   // YYYY-MM-DD
    text:          { type: String, default: '' },

    status: {
      type:    String,
      enum:    ['pending', 'approved', 'accepted', 'rejected'],
      default: 'pending',
    },
    type: {
      type:     String,
      enum:     ['application', 'availability', 'approval', 'reschedule'],
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
