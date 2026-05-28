import mongoose from 'mongoose';
const { Schema } = mongoose;

const applicationSchema = new Schema({
  tradePro:   { type: Schema.Types.ObjectId, ref: 'TradePro',   required: true, index: true },
  site:       { type: Schema.Types.ObjectId, ref: 'Site',       required: true },
  contractor: { type: Schema.Types.ObjectId, ref: 'Contractor', required: true },
  status:        { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  scheduledDate: { type: String, default: null }, // YYYY-MM-DD — set on approval
}, { timestamps: true });

applicationSchema.index({ tradePro: 1, site: 1 }, { unique: true });

export default mongoose.model('Application', applicationSchema);
