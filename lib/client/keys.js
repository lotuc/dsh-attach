/** Terminal key constants and modifier detection shared by the TUI widgets. */
import { isKeyRelease, matchesKey } from '@earendil-works/pi-tui';

export const UP = '\x1b[A';
export const DOWN = '\x1b[B';
export const UP_ALT = '\x1bOA';
export const DOWN_ALT = '\x1bOB';
export const LEFT = '\x1b[D';
export const RIGHT = '\x1b[C';
export const LEFT_ALT = '\x1bOD';
export const RIGHT_ALT = '\x1bOC';
export const ENTER = '\r';
export const ESCAPE = '\x1b';

/** Escape, including Kitty CSI-u (`ESC[27u`) and modifyOtherKeys encodings. */
export function isEscape(data) {
  if (typeof data !== 'string' || data.length === 0) return false;
  if (isKeyRelease(data)) return false;
  return data === ESCAPE || matchesKey(data, 'escape');
}
export const BACKSPACE = '\x7f';
export const BACKSPACE_ALT = '\b';

/**
 * Recognize Ctrl+<letter> across raw control bytes and the terminal encodings
 * that wrap them (Kitty CSI-u and xterm modifyOtherKeys).
 * @param {string} data
 * @param {string} letter
 * @returns {boolean}
 */
export function isCtrlKey(data, letter) {
  const lower = String(letter).toLowerCase();
  const code = lower.charCodeAt(0);
  if (code < 97 || code > 122) return false;
  const control = String.fromCharCode(code - 96);
  if (data === control) return true;
  try {
    if (matchesKey(data, `ctrl+${lower}`)) return true;
  } catch {
    // matchesKey is best-effort; the explicit forms below cover the rest.
  }
  const forms = [
    `\x1b[${code};5u`,
    `\x1b[${code};5:1u`,
    `\x1b[${code - 96};5u`,
    `\x1b[${code - 96};5:1u`,
    `\x1b[27;5;${code}~`,
    `\x1b[27;5;${code - 96}~`,
  ];
  return forms.includes(data);
}

/** True for a plain Up/Down arrow in either CSI or SS3 encoding. */
export function isUp(data) {
  return data === UP || data === UP_ALT;
}

export function isDown(data) {
  return data === DOWN || data === DOWN_ALT;
}

export function isLeft(data) {
  return data === LEFT || data === LEFT_ALT;
}

export function isRight(data) {
  return data === RIGHT || data === RIGHT_ALT;
}

/** Direction of a terminal mouse-wheel event, or 0 for non-wheel input. */
export function wheelDirection(data) {
  if (typeof data !== 'string') return 0;
  const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/u.exec(data);
  if (sgr !== null) {
    const button = Number.parseInt(sgr[1], 10);
    if ((button & 64) === 0) return 0;
    const direction = button & 3;
    return direction === 0 ? -1 : direction === 1 ? 1 : 0;
  }
  if (data.length === 6 && data.startsWith('\x1b[M')) {
    const button = data.charCodeAt(3) - 32;
    if ((button & 64) === 0) return 0;
    const direction = button & 3;
    return direction === 0 ? -1 : direction === 1 ? 1 : 0;
  }
  return 0;
}
