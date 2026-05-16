import mongoose from 'mongoose';

const { Schema } = mongoose;

const siteSchema = new Schema(
  {
    contractor: {
      type: Schema.Types.ObjectId,
      ref:  'Contractor',
      required: true,
      index: true,
    },
    name:    { type: String, required: true, trim: true },
    type:    { type: String, enum: ['residential', 'commercial'], required: true },
    address: { type: String, required: true, trim: true },

    // Trades needed at this site — stored as name strings matching TRADE_PROFESSIONALITIES
    tradesNeeded: [{ type: String, trim: true }],

    photo:  { type: String, default: null }, // Cloudinary URL
    status: {
      type:    String,
      enum:    ['active', 'completed', 'on_hold'],
      default: 'active',
    },

    // Optional notes or description for the site
    notes: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

// Compound index: quickly fetch all sites for a contractor sorted by newest
siteSchema.index({ contractor: 1, createdAt: -1 });

const Site = mongoose.model('Site', siteSchema);
export default Site;
