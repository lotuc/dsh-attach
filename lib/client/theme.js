/**
 * Terminal palette and pi-tui themes.
 *
 * The default palette is deliberately a light one: dark, saturated foreground
 * colours that keep contrast on a white/light terminal. `--theme dark` switches
 * to the previous bright-on-dark palette. All exported colour helpers read the
 * active palette at call time, so switching before the first frame is enough.
 */

const sgr = (open, close) => (text) => `\x1b[${open}m${text}\x1b[${close}m`;
const fg = (n) => (text) => `\x1b[38;5;${n}m${text}\x1b[39m`;

export const bold = sgr('1', '22');
export const dim = sgr('2', '22');
export const italic = sgr('3', '23');
export const underline = sgr('4', '24');

const LIGHT = Object.freeze({
  name: 'light',
  accent: 25,
  green: 28,
  red: 160,
  yellow: 130,
  gray: 242,
  faint: 246,
  cyan: 30,
  purple: 91,
  orange: 166,
  code: 94,
  panelBg: 254,
});

const DARK = Object.freeze({
  name: 'dark',
  accent: 111,
  green: 114,
  red: 203,
  yellow: 221,
  gray: 244,
  faint: 240,
  cyan: 116,
  purple: 141,
  orange: 215,
  code: 180,
  panelBg: 235,
});

let palette = LIGHT;

/**
 * Select the palette used by every subsequent render.
 * @param {'light'|'dark'|undefined} name
 * @returns {'light'|'dark'}
 */
export function setTheme(name) {
  palette = name === 'dark' ? DARK : LIGHT;
  return palette.name;
}

/** @returns {'light'|'dark'} */
export function currentTheme() {
  return palette.name;
}

export const accent = (text) => fg(palette.accent)(text);
export const green = (text) => fg(palette.green)(text);
export const red = (text) => fg(palette.red)(text);
export const yellow = (text) => fg(palette.yellow)(text);
export const gray = (text) => fg(palette.gray)(text);
export const faint = (text) => fg(palette.faint)(text);
export const cyan = (text) => fg(palette.cyan)(text);
export const purple = (text) => fg(palette.purple)(text);
export const orange = (text) => fg(palette.orange)(text);

/** Paint one full line with the panel background (and close it at the end). */
export const panelBg = (text) => `\x1b[48;5;${palette.panelBg}m${text}\x1b[49m`;
export const panelBgStart = () => `\x1b[48;5;${palette.panelBg}m`;

export const markdownTheme = {
  heading: (text) => bold(accent(text)),
  link: (text) => underline(cyan(text)),
  linkUrl: (text) => faint(text),
  code: (text) => fg(palette.code)(text),
  codeBlock: (text) => fg(palette.code)(text),
  codeBlockBorder: (text) => faint(text),
  quote: (text) => italic(gray(text)),
  quoteBorder: (text) => faint(text),
  hr: (text) => faint(text),
  listBullet: (text) => accent(text),
  bold: (text) => bold(text),
  italic: (text) => italic(text),
  strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
  underline: (text) => underline(text),
  codeBlockIndent: '  ',
};

export const selectTheme = {
  selectedPrefix: (text) => accent(text),
  selectedText: (text) => bold(accent(text)),
  description: (text) => faint(text),
  scrollInfo: (text) => faint(text),
  noMatch: (text) => faint(text),
};

export const editorTheme = {
  borderColor: (text) => faint(text),
  selectList: selectTheme,
};
