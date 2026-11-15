/** Shared bordered frame for every modal panel. */
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import { accent, bold, faint, panelBg, panelBgStart } from './theme.js';

/**
 * Frame content as an opaque box so transcript text never shows through.
 * @param {string[]} lines - already-styled single-line content
 * @param {number} width - full overlay width
 * @param {string} title - plain text title
 */
export function boxed(lines, width, title) {
  const inner = Math.max(1, width - 4);
  const titleText = truncateToWidth(String(title), Math.max(1, inner - 4));
  const fill = Math.max(0, width - 6 - visibleWidth(titleText));
  const top = `${accent('╭─ ')}${bold(titleText)} ${faint('─'.repeat(fill))}${accent('╮')}`;
  const bottom = accent(`╰${'─'.repeat(Math.max(0, width - 2))}╯`);
  const body = lines.map((line) => {
    const text = truncateToWidth(String(line ?? ''), inner)
      .replaceAll('\x1b[0m', `\x1b[0m${panelBgStart()}`);
    const padding = ' '.repeat(Math.max(0, inner - visibleWidth(text)));
    return `${accent('│')} ${text}${padding} ${accent('│')}`;
  });
  return [top, ...body, bottom].map((line) => {
    const clipped = truncateToWidth(line, width)
      .replaceAll('\x1b[0m', `\x1b[0m${panelBgStart()}`)
      .replaceAll('\x1b[49m', `\x1b[49m${panelBgStart()}`);
    const padding = ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
    return panelBg(clipped) + panelBg(padding);
  });
}
