/** Shared left-label/right-metadata line fitting. */
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

/**
 * Fit a left label and right-aligned metadata into one line.
 *
 * The right side keeps its full width first; the left label is truncated when
 * the two compete. This keeps state and key hints visible on narrow terminals.
 *
 * @param {string} left
 * @param {string} right
 * @param {number} width
 * @param {{gap?: number}} [options]
 * @returns {string}
 */
export function fitRight(left, right, width, { gap = 2 } = {}) {
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');
  if (rightText === '') return truncateToWidth(leftText, width);

  const rightWidth = visibleWidth(rightText);
  if (rightWidth >= width) return truncateToWidth(rightText, width);

  const room = Math.max(0, width - rightWidth - gap);
  const head = truncateToWidth(leftText, room);
  const padding = ' '.repeat(Math.max(0, width - visibleWidth(head) - rightWidth));
  return `${head}${padding}${rightText}`;
}
