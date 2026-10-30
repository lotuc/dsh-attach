/** Shared scroll-key decoding for the read-only scrollable panels. */
import { matchesKey } from '@earendil-works/pi-tui';
import { isCtrlKey, isDown, isUp, wheelDirection } from './keys.js';

/**
 * Translate one input chunk into a clamped scroll offset.
 *
 * Returns `null` when the input is not a scrolling key, so callers can keep
 * their own close/kill shortcuts first.
 *
 * @param {string} data
 * @param {{scroll: number, maxScroll: number, page: number}} state
 * @returns {number|null}
 */
export function nextScrollOffset(data, { scroll, maxScroll, page }) {
  const pageStep = Math.max(1, page - 2);
  let next;
  const wheel = wheelDirection(data);
  if (wheel !== 0) next = scroll + wheel * 3;
  else if (isUp(data) || isCtrlKey(data, 'p')) next = scroll - 1;
  else if (isDown(data) || isCtrlKey(data, 'n')) next = scroll + 1;
  else if (matchesKey(data, 'pageup') || isCtrlKey(data, 'u')) next = scroll - pageStep;
  else if (matchesKey(data, 'pagedown') || isCtrlKey(data, 'd')) next = scroll + pageStep;
  else if (matchesKey(data, 'home') || data === 'g') next = 0;
  else if (matchesKey(data, 'end') || data === 'G') next = maxScroll;
  else return null;
  return Math.max(0, Math.min(maxScroll, next));
}
