import mongoose from 'mongoose';

const GRADE_NAMES = { 1: 'Poor', 2: 'Fair', 3: 'Good', 4: 'Very Good', 5: 'Excellent' };

const tradeGradeSchema = new mongoose.Schema(
  {
    trade_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'TradePro',      required: true },
    contractor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Contractor',    required: true },
    site_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'Site',          default: null  },
    order_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'WorkHoursOrder',default: null  },
    trade_grade:   { type: Number, min: 1, max: 5, required: true },
    grade_name:    { type: String, required: true },   // 'Poor' … 'Excellent'
    review_text:   { type: String, default: '' },
    photos:        [{ type: String }],                 // Cloudinary URLs
    date:          { type: Date,   default: Date.now },
  },
  { timestamps: true, collection: 'trade_grades' }
);

// One grade per contractor × order (each WorkHoursOrder is independently gradable)
tradeGradeSchema.index({ contractor_id: 1, order_id: 1 }, { unique: true, sparse: true });

// Auto-set grade_name before save
tradeGradeSchema.pre('save', function (next) {
  this.grade_name = GRADE_NAMES[this.trade_grade] || 'Unknown';
  next();
});

export const GRADE_NAMES_MAP = GRADE_NAMES;
export default mongoose.model('TradeGrade', tradeGradeSchema);
