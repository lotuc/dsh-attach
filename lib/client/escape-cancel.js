/** Two Escape presses within this window interrupt the running turn. */
export const ESCAPE_CANCEL_MS = 750;

/**
 * Advance the double-Escape state.
 *
 * @param {number|null} pendingAt - timestamp of the first Escape, or null.
 * @param {number} [now] - current time.
 * @param {number} [windowMs] - maximum gap between presses.
 * @returns {{pendingAt: number|null, cancel: boolean}} `cancel` is true on the
 * second press; otherwise `pendingAt` is the timestamp to arm.
 */
export function escapeCancelStep(pendingAt, now = Date.now(), windowMs = ESCAPE_CANCEL_MS) {
  if (
    pendingAt !== null &&
    Number.isFinite(pendingAt) &&
    now >= pendingAt &&
    now - pendingAt <= windowMs
  ) {
    return { pendingAt: null, cancel: true };
  }
  return { pendingAt: now, cancel: false };
}
