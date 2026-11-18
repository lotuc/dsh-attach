/** Shared scroll-key decoding for the read-only scrollable panels. */
import { matchesKey } from '@earendil-works/pi-tui';
import { isCtrlKey, isDown, isUp, wheelDirection } from './keys.js';

/** Rows advanced by one page key, leaving a two-row overlap. */
function pageStep(page) {
  return Math.max(1, page - 2);
}

/**
 * Translate one input chunk into a clamped selection index for list panes.
 *
 * This mirrors the page/home/end part of {@link nextScrollOffset}; arrow and
 * search keys stay with the list and its input.
 *
 * @param {string} data
 * @param {{index: number, length: number, page: number}} state
 * @returns {number|null}
 */
export function nextSelectionIndex(data, { index, length, page }) {
  if (length <= 0) return null;
  const step = pageStep(page);
  let next;
  if (matchesKey(data, 'pageup') || isCtrlKey(data, 'u')) next = index - step;
  else if (matchesKey(data, 'pagedown') || isCtrlKey(data, 'd')) next = index + step;
  else if (matchesKey(data, 'home')) next = 0;
  else if (matchesKey(data, 'end')) next = length - 1;
  else return null;
  return Math.max(0, Math.min(length - 1, next));
}

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
  const step = pageStep(page);
  let next;
  const wheel = wheelDirection(data);
  if (wheel !== 0) next = scroll + wheel * 3;
  else if (isUp(data) || isCtrlKey(data, 'p')) next = scroll - 1;
  else if (isDown(data) || isCtrlKey(data, 'n')) next = scroll + 1;
  else if (matchesKey(data, 'pageup') || isCtrlKey(data, 'u')) next = scroll - step;
  else if (matchesKey(data, 'pagedown') || isCtrlKey(data, 'd')) next = scroll + step;
  else if (matchesKey(data, 'home') || data === 'g') next = 0;
  else if (matchesKey(data, 'end') || data === 'G') next = maxScroll;
  else return null;
  return Math.max(0, Math.min(maxScroll, next));
}
