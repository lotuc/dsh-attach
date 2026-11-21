/**
 * Shared vocabulary for subagent control failures.
 *
 * The Host maps runtime failures onto stable control codes and the client
 * renders those codes in the terminal. Both sides import this table so the
 * same code always produces the same sentence; capability detection stays in
 * `lib/host/subagent-control.js` and `lib/client/subagent-control.js`.
 */

/** Stable failure code to terminal text. */
export const SUBAGENT_ERROR_TEXT = Object.freeze({
  'subagent/parent-unavailable': 'the subagent parent is not live; open the parent session first',
  'subagent/not-resumable': 'only continuable subagents can be continued',
  'subagent/unauthorized': 'the Host does not authorize this subagent control request',
  'subagent/delivery-unavailable': 'the subagent cannot accept a message right now',
  'subagent/attachment-invalid': 'the subagent rejected the message content',
  'subagent/control-unavailable': 'this Host cannot read the subagent catalog',
  'gateway/bad-request': 'the subagent control request is invalid',
  'gateway/cancelled': 'the subagent control request was cancelled',
  'attach/not-found': 'that subagent is not in the current session lineage',
  'attach/no-session': 'no session is open',
});

/**
 * Translate one control failure code, falling back to caller-provided text.
 *
 * @param {unknown} code
 * @param {string} [fallback]
 * @returns {string}
 */
export function subagentErrorText(code, fallback = '') {
  if (typeof code === 'string' && Object.hasOwn(SUBAGENT_ERROR_TEXT, code)) {
    return SUBAGENT_ERROR_TEXT[code];
  }
  return fallback;
}
