import { sendMail } from './mailer.js';

/**
 * Sends one email, turning a failure into a return value instead of an
 * exception.
 *
 * Any flow that notifies several people in sequence MUST use this rather than a
 * bare `await sendMail(...)`. With a plain await inside a shared try block the
 * first failure aborts every send after it, so the least important recipient can
 * silently cancel the most important one — and the recipient who most needs the
 * message is usually the one written second.
 *
 * `build` is invoked inside the same guard, so template rendering and PDF
 * generation failures are contained too rather than taking the whole step down.
 *
 * @param {object}   opts
 * @param {string}   [opts.to]    recipient; a missing address is a skip, not an error
 * @param {string}   opts.stage   short id used in logs and surfaced as a warning
 * @param {Function} opts.build   () => ({ subject, html, attachments? })
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string }>}
 */
export async function deliverMail({ to, stage, build }) {
  if (!to) {
    console.warn(`[mail] ${stage} skipped — no recipient address`);
    return { ok: false, skipped: true };
  }

  try {
    const payload = typeof build === 'function' ? await build() : build;
    await sendMail({ to, ...payload });
    console.log(`[mail] ${stage} → ${to}`);
    return { ok: true };
  } catch (err) {
    console.error(`[mail] ${stage} → ${to} FAILED: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * deliverMail + push onto a warnings array the caller returns to the client.
 * Keeps the "send, isolate, report" pattern to one line at each call site.
 */
export async function deliverMailWarning({ to, stage, build }, warnings) {
  const result = await deliverMail({ to, stage, build });
  if (result.error) warnings?.push({ stage, message: result.error });
  return result;
}
