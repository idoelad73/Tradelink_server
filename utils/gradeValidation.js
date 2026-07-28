/**
 * Shared input rules for the two rating endpoints. Both directions must agree,
 * so the rules live here rather than being duplicated per controller.
 */

/** Matches the client-side textarea limit in the grade modals. */
export const MAX_REVIEW_CHARS = 500;

/** How long after submitting a rating it may still be changed. 0 = immutable. */
export const EDIT_WINDOW_HOURS = parseFloat(process.env.GRADE_EDIT_WINDOW_HOURS ?? '24');

/**
 * Photo URLs are stored verbatim and later rendered in an <img src>, so only
 * hosts we actually upload to are accepted. A bare `startsWith('http')` check
 * lets a caller point review photos at any server they control — useful for
 * hotlinking and for tracking whoever views the review.
 */
const ALLOWED_PHOTO_HOSTS = new Set(
  (process.env.GRADE_PHOTO_HOSTS ?? 'res.cloudinary.com')
    .split(',')
    .map(h => h.trim())
    .filter(Boolean)
);

/**
 * Accepts only an integer 1–5, as a number or its plain string form.
 * `parseInt` would read "3abc" as 3 and "3.9" as 3; both are rejected here.
 * @returns {number|null} the grade, or null if the input is not a valid grade
 */
export function parseGrade(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const s = String(value).trim();
  return /^[1-5]$/.test(s) ? Number(s) : null;
}

/**
 * @returns {{ ok: true, text: string } | { ok: false, message: string }}
 */
export function normaliseReviewText(value) {
  const text = (value ?? '').toString().trim();
  if (text.length > MAX_REVIEW_CHARS) {
    return { ok: false, message: `Review text must be ${MAX_REVIEW_CHARS} characters or fewer.` };
  }
  return { ok: true, text };
}

/** Drops anything that is not an https URL on an allowed upload host. */
export function sanitisePhotoUrls(photos) {
  if (!Array.isArray(photos)) return [];
  return photos.filter((u) => {
    if (typeof u !== 'string') return false;
    try {
      const { protocol, hostname } = new URL(u);
      return protocol === 'https:' && ALLOWED_PHOTO_HOSTS.has(hostname);
    } catch {
      return false;   // not a parseable URL
    }
  });
}

/**
 * Whether an existing grade may still be edited.
 * @returns {{ allowed: true } | { allowed: false, message: string }}
 */
export function canEditGrade(existing) {
  if (!existing) return { allowed: true };            // first submission

  if (EDIT_WINDOW_HOURS <= 0) {
    return { allowed: false, message: 'This rating has already been submitted and cannot be changed.' };
  }

  const submittedAt = existing.createdAt ?? existing.date;
  const ageHours    = (Date.now() - new Date(submittedAt).getTime()) / 3_600_000;

  if (ageHours > EDIT_WINDOW_HOURS) {
    return {
      allowed: false,
      message: `This rating can no longer be changed — ratings are locked ${EDIT_WINDOW_HOURS} hours after submission.`,
    };
  }
  return { allowed: true };
}
