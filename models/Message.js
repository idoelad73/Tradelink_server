import mongoose from 'mongoose';
const { Schema } = mongoose;

const messageSchema = new Schema(
  {
    tradePro:      { type: Schema.Types.ObjectId, ref: 'TradePro',   required: true, index: true },
    site:          { type: Schema.Types.ObjectId, ref: 'Site',       required: true },
    contractor:    { type: Schema.Types.ObjectId, ref: 'Contractor', required: true },
    requestedDate: { type: String, required: true }, // YYYY-MM-DD
    status:        { type: String, enum: ['pending', 'approved'], default: 'pending' },
  },
  { timestamps: true }
);

const Message = mongoose.model('Message', messageSchema);
export default Message;
