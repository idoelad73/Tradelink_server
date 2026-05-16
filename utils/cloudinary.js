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
    resource_type: isImage ? 'image' : 'raw',
    use_filename: false,
    unique_filename: true,
  });
}

// ── Generic uploader (kept for other future uses) ─────────────────────────────
export function uploadToCloudinary(buffer, folder, resourceType = 'auto') {
  return streamUpload(buffer, { folder, resource_type: resourceType });
}

// ── Delete by public_id ───────────────────────────────────────────────────────
export function deleteFromCloudinary(publicId, resourceType = 'image') {
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
}
