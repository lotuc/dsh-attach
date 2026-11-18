import { copyToClipboard } from './clipboard.js';
import { isEscape } from './keys.js';
import { boxed } from './panel-frame.js';
import { nextScrollOffset } from './scroll.js';

/**
 * Shared scrollable modal body. Subclasses provide content and footer lines;
 * this class owns scrolling, maximize, copy, close and the terminal page size.
 */
export class OverlayPanel {
  constructor({
    title,
    onClose,
    onCopy,
    onToggleFullscreen,
    requestRender,
    fullscreen = false,
    pageRatio = 0.85,
    follow = false,
    fill = true,
    copyEnabled = true,
    copyKey = 'c',
    scrollEnabled = true,
  } = {}) {
    this.title = title;
    this.onClose = onClose;
    this.onCopy = onCopy;
    this.onToggleFullscreen = onToggleFullscreen;
    this.requestRender = requestRender;
    this.fullscreen = fullscreen === true;
    this.pageRatio = pageRatio;
    this.follow = follow === true;
    this.fill = fill !== false;
    this.copyEnabled = copyEnabled !== false;
    this.copyKey = copyKey;
    this.scrollEnabled = scrollEnabled !== false;
    this.scroll = 0;
    this.maxScroll = 0;
    this.page = 1;
  }

  /** @returns {string[]} unstyled/styled body lines, already width-aware */
  contentLines() {
    return [];
  }

  /** @returns {string[]} footer lines, without the blank separator */
  footerLines() {
    return [];
  }

  /** Raw text used by the `c` copy shortcut; empty disables copy. */
  copyText() {
    return '';
  }

  /** Subclass key handling before the shared shortcuts. Return true when consumed. */
  handlePanelInput() {
    return false;
  }

  #scrollTo(value) {
    const next = Math.max(0, Math.min(this.maxScroll, value));
    const previousFollow = this.follow;
    this.follow = next >= this.maxScroll;
    if (next === this.scroll && previousFollow === this.follow) return;
    this.scroll = next;
    this.requestRender?.();
  }

  handleInput(data) {
    if (this.handlePanelInput(data) === true) return;
    if (data === 'F') {
      this.fullscreen = !this.fullscreen;
      this.onToggleFullscreen?.(this.fullscreen);
      return;
    }
    if (this.copyEnabled && data === this.copyKey) {
      const text = this.copyText();
      if (text === '') return;
      const copied = copyToClipboard(text);
      this.onCopy?.(copied);
      return;
    }
    const next = this.scrollEnabled
      ? nextScrollOffset(data, { scroll: this.scroll, maxScroll: this.maxScroll, page: this.page })
      : null;
    if (next !== null) {
      this.#scrollTo(next);
      return;
    }
    if (data === 'q' || data === 'Q' || isEscape(data)) this.onClose?.();
  }

  /** Position suffix shared by scrollable footers. */
  positionLabel(total = this.lastContentLength ?? 0) {
    if (total <= this.page) return '';
    const end = Math.min(total, this.scroll + this.page);
    return `lines ${this.scroll + 1}-${end}/${total} · `;
  }

  render(width) {
    const rows = Math.max(8, process.stdout.rows ?? 24);
    this.page = Math.max(4, Math.min(40, Math.floor(rows * this.pageRatio) - 4));
    const lines = this.contentLines(width);
    this.lastContentLength = lines.length;
    this.maxScroll = Math.max(0, lines.length - this.page);
    if (this.follow) this.scroll = this.maxScroll;
    this.scroll = Math.min(this.scroll, this.maxScroll);
    const body = lines.slice(this.scroll, this.scroll + this.page);
    if (this.fill || this.fullscreen) while (body.length < this.page) body.push('');
    const footer = this.footerLines(width);
    return boxed([...body, '', ...footer], width, this.title, { sideBorders: !this.fullscreen });
  }
}
