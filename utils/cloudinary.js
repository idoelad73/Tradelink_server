import { v2 as cloudinary } from 'cloudinary';
import path from 'path';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Base stream uploader ──────────────────────────────────────────────────────
function streamUpload(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
    stream.end(buffer);
  });
}

// ── Profile photo ─────────────────────────────────────────────────────────────
// Stores as image, auto-converts to WebP, caps at 400×400.
export function uploadPhoto(buffer, folder = 'tradelink/photos') {
  return streamUpload(buffer, {
    folder,
    resource_type: 'image',
    format: 'webp',
    transformation: [
      { width: 400, height: 400, crop: 'fill', gravity: 'face' },
      { quality: 'auto' },
    ],
  });
}

// ── Documents (PDF / Word / image scan) ───────────────────────────────────────
// resource_type 'auto' lets Cloudinary store PDFs and Word docs as raw assets
// while still handling image scans correctly.
export function uploadDocument(buffer, folder, originalName = '') {
  const ext  = path.extname(originalName).toLowerCase();
  const isImage = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);

  return streamUpload(buffer, {
    folder,
    resource_type:   isImage ? 'image' : 'raw',
    use_filename:    true,   // preserve original filename in public_id
    unique_filename: true,   // add unique suffix to avoid collisions
  });
}

// ── Generic uploader (kept for other future uses) ─────────────────────────────
export function uploadToCloudinary(buffer, folder, resourceType = 'auto') {
  return streamUpload(buffer, { folder, resource_type: resourceType });
}

// ── Chat file uploader ────────────────────────────────────────────────────────
// For RAW files (PDF/Word) the public_id MUST include the file extension so the
// Cloudinary URL ends in .docx / .pdf and browsers download with the right name.
export function uploadChatFile(buffer, originalName = '') {
  const ext      = path.extname(originalName).toLowerCase();
  const isImage  = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
  // Sanitise filename and embed extension in the public_id (for raw files)
  const safeName = path.basename(originalName, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
  const publicId = `tradelink/chat/${Date.now()}_${safeName}${isImage ? '' : ext}`;

  return streamUpload(buffer, {
    folder:          undefined,        // public_id already contains the folder
    public_id:       publicId,
    resource_type:   isImage ? 'image' : 'raw',
    use_filename:    false,
    unique_filename: false,
    overwrite:       false,
  });
}

// ── Delete by public_id ───────────────────────────────────────────────────────
export function deleteFromCloudinary(publicId, resourceType = 'image') {
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
}
