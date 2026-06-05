import mongoose from 'mongoose';
const { Schema } = mongoose;

const messageSchema = new Schema(
  {
    tradePro:      { type: Schema.Types.ObjectId, ref: 'TradePro',   required: true, index: true },
    site:          { type: Schema.Types.ObjectId, ref: 'Site',       required: true },
    contractor:    { type: Schema.Types.ObjectId, ref: 'Contractor', required: true },
    requestedDate: { type: String, default: '' },        // YYYY-MM-DD
    text:          { type: String, default: '' },        // message body for direct chat
    status:          { type: String, enum: ['pending', 'approved'], default: 'pending' },
    type:            { type: String, enum: ['availability', 'approval'], default: 'availability' },
    senderType:      { type: String, enum: ['trade', 'contractor'], required: true },
  },
  { timestamps: true }
);

// Fetch full conversation thread between a trade pro and contractor, sorted by time
messageSchema.index({ tradePro: 1, contractor: 1, createdAt: 1 });

const Message = mongoose.model('Message', messageSchema);
export default Message;
