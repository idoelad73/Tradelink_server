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

    // Trades needed at this site — each entry tracks name + whether a pro is assigned
    tradesNeeded: [{
      _id:      false,
      name:     { type: String, required: true, trim: true },
      assigned: { type: Boolean, default: false },
    }],

    photo:  { type: String, default: null }, // Cloudinary URL
    status: {
      type:    String,
      enum:    ['active', 'completed', 'on_hold'],
      default: 'active',
    },

    // Optional notes or description for the site
    notes: { type: String, trim: true, default: '' },

    // GeoJSON point — populated by geocoding the address on create
    location: {
      type:        { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] }, // [lng, lat]
    },
  },
  { timestamps: true }
);

// Compound index: quickly fetch all sites for a contractor sorted by newest
siteSchema.index({ contractor: 1, createdAt: -1 });
siteSchema.index({ location: '2dsphere' });

const Site = mongoose.model('Site', siteSchema);
export default Site;
