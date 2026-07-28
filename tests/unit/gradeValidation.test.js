import { describe, it, expect } from 'vitest';
import { parseGrade, normaliseReviewText, sanitisePhotoUrls, canEditGrade, MAX_REVIEW_CHARS } from '../../utils/gradeValidation.js';

describe('parseGrade', () => {
  it('accepts 1–5 as numbers and as plain strings', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(parseGrade(n)).toBe(n);
      expect(parseGrade(String(n))).toBe(n);
    }
    expect(parseGrade(' 4 ')).toBe(4);
  });

  it('rejects the values parseInt would silently accept', () => {
    // parseInt('3abc') === 3 and parseInt('3.9') === 3 — both were stored as 3.
    expect(parseGrade('3abc')).toBeNull();
    expect(parseGrade('3.9')).toBeNull();
    expect(parseGrade('5x')).toBeNull();
    expect(parseGrade('0x3')).toBeNull();
  });

  it('rejects out-of-range and non-scalar input', () => {
    for (const bad of [0, 6, -1, 2.5, 'abc', '', null, undefined, NaN, {}, [], [3], true, false]) {
      expect(parseGrade(bad)).toBeNull();
    }
  });
});

describe('normaliseReviewText', () => {
  it('trims and passes through ordinary text', () => {
    expect(normaliseReviewText('  Great work  ')).toEqual({ ok: true, text: 'Great work' });
  });

  it('treats missing text as empty', () => {
    expect(normaliseReviewText(undefined)).toEqual({ ok: true, text: '' });
    expect(normaliseReviewText(null)).toEqual({ ok: true, text: '' });
  });

  it(`accepts exactly ${MAX_REVIEW_CHARS} characters`, () => {
    const res = normaliseReviewText('x'.repeat(MAX_REVIEW_CHARS));
    expect(res.ok).toBe(true);
  });

  it('rejects one character over the limit', () => {
    const res = normaliseReviewText('x'.repeat(MAX_REVIEW_CHARS + 1));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/500 characters or fewer/);
  });
});

describe('sanitisePhotoUrls', () => {
  it('keeps https URLs on allowlisted hosts', () => {
    expect(sanitisePhotoUrls([
      'https://res.cloudinary.com/demo/image/upload/a.jpg',
      'https://cdn.test/photo.jpg',
    ])).toEqual([
      'https://res.cloudinary.com/demo/image/upload/a.jpg',
      'https://cdn.test/photo.jpg',
    ]);
  });

  it('drops arbitrary third-party hosts', () => {
    // These were previously stored and rendered in an <img src>, letting the
    // submitter point review images at a server they control.
    expect(sanitisePhotoUrls([
      'https://evil.test/tracker.png',
      'http://res.cloudinary.com/demo/a.jpg',        // plain http
      'https://res.cloudinary.com.evil.test/a.jpg',  // lookalike host
    ])).toEqual([]);
  });

  it('drops non-http schemes and junk', () => {
    expect(sanitisePhotoUrls([
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'not a url',
      42, null, undefined, {},
    ])).toEqual([]);
  });

  it('returns an empty array for a non-array', () => {
    expect(sanitisePhotoUrls('https://cdn.test/a.jpg')).toEqual([]);
    expect(sanitisePhotoUrls(undefined)).toEqual([]);
  });
});

describe('canEditGrade', () => {
  const hoursAgo = (h) => ({ createdAt: new Date(Date.now() - h * 3_600_000) });

  it('allows a first submission', () => {
    expect(canEditGrade(null).allowed).toBe(true);
  });

  it('allows an edit inside the window', () => {
    expect(canEditGrade(hoursAgo(1)).allowed).toBe(true);
    expect(canEditGrade(hoursAgo(23.5)).allowed).toBe(true);
  });

  it('blocks an edit after the window', () => {
    const res = canEditGrade(hoursAgo(25));
    expect(res.allowed).toBe(false);
    expect(res.message).toMatch(/no longer be changed/);
  });

  it('falls back to `date` when createdAt is absent', () => {
    expect(canEditGrade({ date: new Date(Date.now() - 100 * 3_600_000) }).allowed).toBe(false);
  });
});
