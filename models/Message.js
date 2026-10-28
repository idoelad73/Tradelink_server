import mongoose from 'mongoose';
const { Schema } = mongoose;

/**
 * Unified "JobRequest / Message" collection.
 *
 * type         | senderType  | status             | meaning
 * -------------|-------------|--------------------|-----------------------------------------
 * application  | trade       | pending/approved   | Trade pro applied to work on a site
 * availability | contractor  | pending            | Contractor asked if trade is available
 * approval     | contractor  | approved           | Contractor approved the trade
 * reschedule   | trade       | pending            | Trade pro asked to change booked date
 * worker_offer | trade       | pending/approved   | Trade pro confirmed workers count — awaits contractor approval
 * payment      | trade       | pending            | Trade submitted hours (no WorkHoursOrder yet)
 * payment      | contractor  | approved           | Contractor approved → WorkHoursOrder created
 * payment      | contractor  | rejected           | Contractor rejected → snapshot in text field
 * total_hours_explanations | contractor | approved | Contractor's rate/hours explanation for one
 *              |             |                    | trade slot (site + tradeName); text = the comment.
 *              |             |                    | Mirrors Site.tradesNeeded[].rateComment — see
 *              |             |                    | utils/rateExplanations.js. No tradePro.
 */
export const RATE_EXPLANATION_TYPE = 'total_hours_explanations';

const messageSchema = new Schema(
  {
    // Required except on contractor rate explanations, which belong to a trade slot, not a pro
    tradePro:      { type: Schema.Types.ObjectId, ref: 'TradePro',   required: function () { return this.type !== RATE_EXPLANATION_TYPE; }, index: true },
    site:          { type: Schema.Types.ObjectId, ref: 'Site',       default: null },
    contractor:    { type: Schema.Types.ObjectId, ref: 'Contractor', required: true },
    requestedDate: { type: String, default: '' },   // YYYY-MM-DD
    text:          { type: String, default: '' },
    tradeName:      { type: String,  default: '' }, // e.g. 'Painter' — which trade slot this fills
    workersOffered: { type: Number,  default: 1    }, // how many workers this TradePro is offering
    totalHours:     { type: Number,  default: null }, // total job hours — set by contractor on direct-search requests
    min_deposit:    { type: Number,  default: null }, // workersOffered × hourlyRate × totalHours (set on approval)
    order_sum:      { type: Number,  default: null }, // locked sum approved by contractor (actual_hours × rate × workers)
    stripeDepositIntentId: { type: String, default: null },
    depositStatus: {
      type:    String,
      enum:    ['pending', 'held', 'captured', 'released'],
      default: null,
    },

    status: {
      type:    String,
      enum:    ['pending', 'approved', 'accepted', 'rejected', 'deposited'],
      default: 'pending',
    },
    type: {
      type:     String,
      enum:     ['application', 'availability', 'approval', 'reschedule', 'worker_offer', 'payment', RATE_EXPLANATION_TYPE],
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

// Unique: one rate explanation per site + trade slot
messageSchema.index(
  { site: 1, tradeName: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: RATE_EXPLANATION_TYPE } }
);

const Message = mongoose.model('Message', messageSchema);
export default Message;
