/** Shared bordered frame for every modal panel. */
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import { accent, bold, faint, panelBg, panelBgStart } from './theme.js';

/**
 * Frame content as an opaque box so transcript text never shows through.
 * @param {string[]} lines - already-styled single-line content
 * @param {number} width - full overlay width
 * @param {string} title - plain text title
 * @param {{sideBorders?: boolean}} [options] - full-screen frames drop the
 *   vertical edges but keep the title rule and the bottom rule
 */
export function boxed(lines, width, title, { sideBorders = true } = {}) {
  const inner = Math.max(1, width - 4);
  const titleText = truncateToWidth(String(title), Math.max(1, inner - 4));
  const fill = Math.max(0, width - 6 - visibleWidth(titleText));
  const top = sideBorders
    ? `${accent('╭─ ')}${bold(titleText)} ${faint('─'.repeat(fill))}${accent('╮')}`
    : `${accent('─ ')}${bold(titleText)} ${faint('─'.repeat(Math.max(0, width - 3 - visibleWidth(titleText))))}`;
  const bottom = sideBorders
    ? accent(`╰${'─'.repeat(Math.max(0, width - 2))}╯`)
    : accent('─'.repeat(Math.max(0, width)));
  const body = lines.map((line) => {
    const text = truncateToWidth(String(line ?? ''), inner)
      .replaceAll('\x1b[0m', `\x1b[0m${panelBgStart()}`);
    const padding = ' '.repeat(Math.max(0, inner - visibleWidth(text)));
    return sideBorders
      ? `${accent('│')} ${text}${padding} ${accent('│')}`
      : `  ${text}${padding}  `;
  });
  return [top, ...body, bottom].map((line) => {
    const clipped = truncateToWidth(line, width)
      .replaceAll('\x1b[0m', `\x1b[0m${panelBgStart()}`)
      .replaceAll('\x1b[49m', `\x1b[49m${panelBgStart()}`);
    const padding = ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
    return panelBg(clipped) + panelBg(padding);
  });
}
