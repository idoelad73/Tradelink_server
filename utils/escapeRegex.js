// Escapes a string for literal use inside a RegExp. Use whenever user-supplied
// text (e.g. a trade name) is matched case-insensitively with $regex — without
// it, characters like ( ) + * ? [ ] are interpreted as pattern syntax, which can
// match the wrong document or be abused for catastrophic backtracking.
export function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Case-insensitive exact-match regex for a value (anchored, escaped).
export function exactCaseInsensitive(str) {
  return new RegExp(`^${escapeRegex(str)}$`, 'i');
}
