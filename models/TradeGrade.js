import mongoose from 'mongoose';

const GRADE_NAMES = { 1: 'Poor', 2: 'Fair', 3: 'Good', 4: 'Very Good', 5: 'Excellent' };

const tradeGradeSchema = new mongoose.Schema(
  {
    trade_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'TradePro',      required: true },
    contractor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Contractor',    required: true },
    site_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'Site',          default: null  },
    order_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'WorkHoursOrder',default: null  },
    grade_type:    { type: String, enum: ['trade', 'contractor'], default: 'trade' },
    trade_grade:   { type: Number, min: 1, max: 5, required: true },
    grade_name:    { type: String, required: true },   // 'Poor' … 'Excellent'
    review_text:   { type: String, default: '', maxlength: 500 },
    photos:        [{ type: String }],                 // Cloudinary URLs
    date:          { type: Date,   default: Date.now },
    // Edit tracking — a rating may be changed for a limited window after it is
    // first submitted (see utils/gradeValidation.js). Recorded so a review that
    // was revised can be shown as such rather than passing for the original.
    editedAt:      { type: Date,   default: null },
    editCount:     { type: Number, default: 0    },
  },
  { timestamps: true, collection: 'trade_grades' }
);

// One grade per order PER DIRECTION. `grade_type` must be part of the key:
// every document carries both contractor_id and trade_id, so a key without it
// cannot tell "contractor rated the pro" apart from "pro rated the contractor"
// and the two sides of the same job overwrite each other.
//
// Partial rather than sparse: a compound sparse index only skips documents
// missing *every* field, and grade_type always has a value, so legacy rows with
// a null order_id would still be indexed and collide with each other.
tradeGradeSchema.index(
  { order_id: 1, grade_type: 1 },
  { unique: true, partialFilterExpression: { order_id: { $type: 'objectId' } } }
);
// Fast lookup of all reviews for a given trade pro
tradeGradeSchema.index({ trade_id: 1, createdAt: -1 });

// Auto-set grade_name before save
tradeGradeSchema.pre('save', function (next) {
  this.grade_name = GRADE_NAMES[this.trade_grade] || 'Unknown';
  next();
});

export const GRADE_NAMES_MAP = GRADE_NAMES;
export default mongoose.model('TradeGrade', tradeGradeSchema);
