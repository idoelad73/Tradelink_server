// Single source of truth for the account password policy. Used at every point a
// password is SET — registration (trade + contractor) and password reset — so
// the rule can't drift between them (QA finding A3: reset required ≥8 while
// registration required nothing at all).
//
// Policy (per product decision):
//   • exactly 8 characters
//   • at least one uppercase letter   A–Z
//   • at least one lowercase letter   a–z
//   • at least one symbol             e.g. ! # $ % (any non-alphanumeric)
//
// NOTE: "exactly 8" is intentionally fixed-length per request. A *minimum* of 8
// would be stronger (longer passwords add entropy); to switch, change the first
// rule's test to `p.length >= 8` and its label to "be at least 8 characters".

const RULES = [
  { test: (p) => p.length === 8,         label: 'be exactly 8 characters long' },
  { test: (p) => /[A-Z]/.test(p),        label: 'include at least one uppercase letter (A–Z)' },
  { test: (p) => /[a-z]/.test(p),        label: 'include at least one lowercase letter (a–z)' },
  { test: (p) => /[^A-Za-z0-9]/.test(p), label: 'include at least one symbol (e.g. ! # $ %)' },
];

/**
 * Human-readable policy description. Hand this to clients so the requirements
 * can be shown up front (and matched against the 400 message on failure).
 */
export const PASSWORD_POLICY_TEXT =
  'Password must be exactly 8 characters and include an uppercase letter, a lowercase letter, and a symbol (e.g. ! # $).';

/** The rules as data, for a UI that wants to render a live checklist. */
export const PASSWORD_RULES = RULES.map((r) => r.label);

/**
 * @param {unknown} password
 * @returns {{ ok: true } | { ok: false, message: string, unmet: string[] }}
 *   On failure, `message` spells out every unmet rule so the user can fix the
 *   password in one go rather than discovering requirements one at a time.
 */
export function validatePassword(password) {
  if (typeof password !== 'string') {
    return { ok: false, message: PASSWORD_POLICY_TEXT, unmet: PASSWORD_RULES };
  }
  const unmet = RULES.filter((r) => !r.test(password)).map((r) => r.label);
  if (unmet.length === 0) return { ok: true };
  return { ok: false, message: `Password must ${unmet.join(', and ')}.`, unmet };
}
