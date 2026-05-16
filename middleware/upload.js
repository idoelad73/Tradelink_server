import multer from 'multer';

// All uploads stay in memory — piped to Cloudinary before DB write
const storage = multer.memoryStorage();

// ── Allowed MIME types ────────────────────────────────────────────────────────
const PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const DOCUMENT_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp',
  'application/pdf',
  'application/msword',                                                          // .doc
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   // .docx
]);

// ── File filters ──────────────────────────────────────────────────────────────
function photoFilter(_req, file, cb) {
  PHOTO_MIME.has(file.mimetype)
    ? cb(null, true)
    : cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname), false);
}

function documentFilter(_req, file, cb) {
  DOCUMENT_MIME.has(file.mimetype)
    ? cb(null, true)
    : cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname), false);
}

// ── Multer instances ──────────────────────────────────────────────────────────

// Profile photo only — 5 MB, images only
export const photoUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: photoFilter,
});

// Single document (license / insurance / CV) — 10 MB, PDF + Word + image
export const documentUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: documentFilter,
});

// Trade registration — all 4 fields in one multipart request
export const tradeRegistrationUpload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // per-file
    files: 4,
  },
  fileFilter(_req, file, cb) {
    const allowed = file.fieldname === 'photo' ? PHOTO_MIME : DOCUMENT_MIME;
    allowed.has(file.mimetype)
      ? cb(null, true)
      : cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname), false);
  },
}).fields([
  { name: 'photo',        maxCount: 1 },
  { name: 'licenseDoc',   maxCount: 1 },
  { name: 'insuranceDoc', maxCount: 1 },
  { name: 'cv',           maxCount: 1 },
]);

// ── Multer error handler (place after any route that uses upload) ─────────────
const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE:      'File is too large. Maximum size is 10 MB.',
  LIMIT_FILE_COUNT:     'Too many files uploaded at once.',
  LIMIT_FIELD_COUNT:    'Too many form fields.',
  LIMIT_UNEXPECTED_FILE:'Invalid file type for this field.',
};

export function handleUploadError(err, _req, res, next) {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: MULTER_MESSAGES[err.code] || `Upload error: ${err.message}`,
      field: err.field,
    });
  }
  // Non-multer errors (e.g. our custom fileFilter errors) pass through
  next(err);
}
