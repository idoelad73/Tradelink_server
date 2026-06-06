import mongoose from 'mongoose';
const { Schema } = mongoose;

const messageSchema = new Schema({
  sender:    { type: String, enum: ['contractor', 'trade'], required: true },
  text:      { type: String, default: '' },
  // Optional attachment uploaded to Cloudinary
  fileUrl:       { type: String, default: null },   // secure_url
  filePublicId:  { type: String, default: null },   // public_id for deletion
  fileName:      { type: String, default: null },   // original filename
  fileType:      { type: String, default: null },   // 'image' | 'pdf' | 'word'
  timestamp: { type: Date, default: Date.now },
});

const chatSchema = new Schema(
  {
    contractorId: { type: Schema.Types.ObjectId, ref: 'Contractor', required: true, index: true },
    tradeProId:   { type: Schema.Types.ObjectId, ref: 'TradePro',   required: true, index: true },
    siteId:       { type: Schema.Types.ObjectId, ref: 'Site',       required: true, index: true },
    siteName:     { type: String, default: '' },
    tradeName:    { type: String, default: '' },  // trade pro's full name
    messages:     [messageSchema],
  },
  { timestamps: true }
);

// Unique chat per contractor+tradePro+site
chatSchema.index({ contractorId: 1, tradeProId: 1, siteId: 1 }, { unique: true });

const Chat = mongoose.model('Chat', chatSchema);
export default Chat;
