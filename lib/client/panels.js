/** Modal panels used by the attach TUI. */
import { Container, Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { accent, bold, faint, gray, green, italic, panelBg, red, selectTheme, yellow } from './theme.js';
import { sanitizeText } from './transcript.js';
import {
  DOWN,
  ENTER,
  UP,
  isCtrlKey,
  isDown,
  isEscape,
  isLeft,
  isRight,
  isUp,
} from './keys.js';

function wrap(text, width) {
  if (width <= 0) return [''];
  return wrapTextWithAnsi(sanitizeText(text), width);
}

/**
 * Frame content as an opaque box so transcript text never shows through.
 * @param {string[]} lines - already-styled single-line content
 * @param {number} width - full overlay width
 * @param {string} title - plain text title
 */
function boxed(lines, width, title) {
  const inner = Math.max(1, width - 4);
  const titleText = truncateToWidth(String(title), Math.max(1, inner - 4));
  const fill = Math.max(0, width - 6 - visibleWidth(titleText));
  const top = `${accent('╭─ ')}${bold(titleText)} ${faint('─'.repeat(fill))}${accent('╮')}`;
  const bottom = accent(`╰${'─'.repeat(Math.max(0, width - 2))}╯`);
  const body = lines.map((line) => {
    const text = truncateToWidth(String(line ?? ''), inner);
    const padding = ' '.repeat(Math.max(0, inner - visibleWidth(text)));
    return `${accent('│')} ${text}${padding} ${accent('│')}`;
  });
  return [top, ...body, bottom].map((line) => {
    const clipped = truncateToWidth(line, width);
    const padding = ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
    return panelBg(clipped) + panelBg(padding);
  });
}

/** Simple scroll-free information panel closed with esc/enter/q. */
export class InfoPanel {
  constructor(title, lines, onClose) {
    this.title = title;
    this.lines = lines;
    this.onClose = onClose;
    this.focused = false;
  }

  handleInput(data) {
    if (data === 'q' || isEscape(data) || data === '\r' || data === '\n') this.onClose();
  }

  render(width) {
    const inner = Math.max(1, width - 6);
    const out = [];
    for (const line of this.lines) {
      if (line === '') {
        out.push('');
        continue;
      }
      for (const wrapped of wrap(line, inner)) out.push(wrapped);
    }
    out.push('');
    out.push(faint('esc close'));
    return boxed(out, width, this.title);
  }
}

/** Non-interactive overlay shown while a slow list request is in flight. */
export class LoadingPanel {
  constructor(title, text = 'Loading…') {
    this.title = title;
    this.text = text;
    this.focused = false;
  }

  // The request has no cancellation path; ignore keys while it is in flight.
  handleInput() {}

  render(width) {
    const inner = Math.max(1, width - 6);
    const out = wrap(this.text, inner);
    out.push('');
    out.push(faint('please wait'));
    return boxed(out, width, this.title);
  }
}

/** Whether raw terminal input is a plain printable sequence (not a control key). */
function isPrintableInput(data) {
  if (typeof data !== 'string' || data.length === 0) return false;
  if (/[\u0000-\u001f\u007f]/u.test(data)) return false;
  return /[\u0020-\u007e\u00a0-\uffff]/u.test(data);
}

/** Keep right-aligned metadata visible while truncating the left side. */
function fitItemLine(left, right, width) {
  if (right === '') return truncateToWidth(left, width);
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width);
  const leftWidth = Math.max(1, width - rightWidth - 2);
  const head = truncateToWidth(left, leftWidth);
  const gap = ' '.repeat(Math.max(1, width - visibleWidth(head) - rightWidth));
  return `${head}${gap}${right}`;
}

/**
 * Incremental-filter list with the small surface the picker needs.
 *
 * `SelectList` filters on `value` only and prefix-matches it; pickers need to
 * search titles, working directories, descriptions and provider/model strings.
 * This list keeps its own items and filters every field by substring tokens.
 */
export class FilterList {
  constructor(items, maxVisible = 12, theme = selectTheme) {
    this.items = items;
    this.maxVisible = Math.max(1, maxVisible);
    this.theme = theme;
    this.filtered = [];
    this.selectedIndex = 0;
    this.currentQuery = '';
    this.collapsedGroups = new Set();
    this.onSelect = undefined;
    this.onCancel = undefined;
    this.onSelectionChange = undefined;
    this.setFilter('');
  }

  #haystack(item) {
    return `${item.label}\n${item.description ?? ''}\n${item.value ?? ''}`.toLowerCase();
  }

  #matches(item, tokens) {
    if (tokens.length === 0) return true;
    const haystack = this.#haystack(item);
    const words = haystack.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
    return tokens.every((token) => {
      // A single ASCII letter is too broad as a substring ("a" appears in
      // "workspace"); require a word start for it.
      if (/^[a-z0-9]$/u.test(token)) return words.some((word) => word.startsWith(token));
      return haystack.includes(token);
    });
  }

  setFilter(query, { preserveSelection = false } = {}) {
    const previous = preserveSelection ? this.getSelectedItem() : null;
    this.currentQuery = String(query ?? '');
    const tokens = this.currentQuery
      .toLowerCase()
      .split(/\s+/u)
      .filter((token) => token !== '');
    const groups = this.items.filter((item) => item.kind === 'group');
    const sessions = this.items.filter((item) => item.kind === 'session');
    const plain = this.items.filter((item) => item.kind !== 'group' && item.kind !== 'session');

    let filtered;
    if (tokens.length === 0) {
      const visible = new Set(plain);
      for (const group of groups) visible.add(group);
      for (const session of sessions) {
        if (!this.collapsedGroups.has(session.groupKey)) visible.add(session);
      }
      filtered = this.items.filter((item) => visible.has(item));
    } else {
      const matchedGroups = new Set();
      for (const group of groups) {
        if (this.#matches(group, tokens)) matchedGroups.add(group.groupKey);
      }
      const matchedSessions = new Set();
      for (const session of sessions) {
        if (this.#matches(session, tokens)) matchedSessions.add(session);
      }
      for (const session of matchedSessions) matchedGroups.add(session.groupKey);
      const visible = new Set();
      for (const item of plain) if (this.#matches(item, tokens)) visible.add(item);
      for (const group of groups) if (matchedGroups.has(group.groupKey)) visible.add(group);
      for (const session of sessions) {
        // A matching Workspace header reveals all of its children; otherwise
        // only the sessions that matched are shown.
        if (matchedGroups.has(session.groupKey)) visible.add(session);
      }
      filtered = this.items.filter((item) => visible.has(item));
    }

    this.filtered = filtered;
    if (previous !== null && previous !== undefined) {
      const index = filtered.indexOf(previous);
      this.selectedIndex = index >= 0 ? index : 0;
    } else {
      this.selectedIndex = 0;
    }
    if (this.filtered.length === 0) this.selectedIndex = 0;
  }

  setCollapsed(groupKey, collapsed) {
    if (collapsed) this.collapsedGroups.add(groupKey);
    else this.collapsedGroups.delete(groupKey);
    this.setFilter(this.currentQuery, { preserveSelection: true });
  }

  toggleGroup(groupKey) {
    this.setCollapsed(groupKey, !this.collapsedGroups.has(groupKey));
  }

  setSelectedIndex(index) {
    this.selectedIndex = Math.max(0, Math.min(index, this.filtered.length - 1));
  }

  getSelectedItem() {
    return this.filtered[this.selectedIndex] ?? null;
  }

  move(delta) {
    if (this.filtered.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.filtered.length) % this.filtered.length;
    this.onSelectionChange?.(this.getSelectedItem());
  }

  select() {
    const item = this.getSelectedItem();
    if (item === null) return;
    if (item.kind === 'group') {
      this.toggleGroup(item.groupKey);
      return;
    }
    this.onSelect?.(item);
  }

  #horizontal(direction) {
    const item = this.getSelectedItem();
    if (item === null) return;
    if (item.kind === 'group') {
      this.setCollapsed(item.groupKey, direction < 0);
      return;
    }
    if (item.kind === 'session' && item.groupKey !== undefined) {
      if (direction > 0) {
        this.setCollapsed(item.groupKey, false);
        return;
      }
      this.setCollapsed(item.groupKey, true);
      const index = this.filtered.findIndex((entry) => entry.kind === 'group' && entry.groupKey === item.groupKey);
      if (index >= 0) this.selectedIndex = index;
    }
  }

  handleInput(data) {
    if (isUp(data) || isCtrlKey(data, 'p')) this.move(-1);
    else if (isDown(data) || isCtrlKey(data, 'n')) this.move(1);
    else if (isLeft(data)) this.#horizontal(-1);
    else if (isRight(data)) this.#horizontal(1);
    else if (data === '\r' || data === '\n') this.select();
    else if (isEscape(data)) this.onCancel?.();
  }

  render(width) {
    if (this.filtered.length === 0) return [this.theme.noMatch('  no match')];
    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filtered.length - this.maxVisible),
    );
    const end = Math.min(start + this.maxVisible, this.filtered.length);
    const lines = [];
    for (let index = start; index < end; index += 1) {
      const item = this.filtered[index];
      const selected = index === this.selectedIndex;
      const prefix = selected ? this.theme.selectedPrefix('→ ') : '  ';
      const meta = item.meta === undefined ? '' : this.theme.description(sanitizeText(item.meta));
      let body;
      if (item.kind === 'group') {
        const collapsed = this.collapsedGroups.has(item.groupKey) && this.currentQuery.trim() === '';
        const marker = collapsed ? '▸' : '▾';
        const current = item.current === true ? ` ${accent('★')}` : '';
        const label = `${marker} ${sanitizeText(item.label)}${current}`;
        body = selected ? this.theme.selectedText(label) : item.running === true ? green(label) : bold(accent(label));
      } else if (item.kind === 'session') {
        const indent = '  '.repeat(Math.max(1, item.depth ?? 1));
        const dot = item.running === true ? `${green('●')} ` : `${faint('○')} `;
        const current = item.current === true ? ` ${accent('★')}` : '';
        const label = `${indent}${dot}${sanitizeText(item.label)}${current}`;
        body = selected ? this.theme.selectedText(label) : label;
      } else {
        body = selected ? this.theme.selectedText(sanitizeText(item.label)) : sanitizeText(item.label);
      }
      if (meta !== '') {
        lines.push(fitItemLine(`${prefix}${body}`, meta, width));
        continue;
      }
      const description = item.description === undefined ? '' : `  ${this.theme.description(sanitizeText(item.description))}`;
      lines.push(truncateToWidth(`${prefix}${body}${description}`, width));
    }
    if (this.filtered.length > this.maxVisible) {
      lines.push(this.theme.scrollInfo(`  (${this.selectedIndex + 1}/${this.filtered.length})`));
    }
    return lines;
  }
}

/**
 * Session/model picker: a titled FilterList with vim/Emacs navigation and an
 * incremental search mode.
 *
 * Navigation: Ctrl+N/Ctrl+P and arrows.
 * Search: `/` enters search, or simply start typing; Enter selects, Esc leaves
 * search (clears the query), Ctrl+U clears, Ctrl+W deletes a word.
 */
export class PickerPanel {
  constructor(title, list, { onCancel, requestRender, hint = '', onKey } = {}) {
    this.title = title;
    this.list = list;
    this.onCancel = onCancel;
    this.requestRender = requestRender;
    this.hint = typeof hint === 'string' ? hint : '';
    this.onKey = onKey;
    this._focused = false;
    this.mode = 'nav';
    this.searchInput = new Input();
    this.searchInput.onSubmit = () => {
      this.list.handleInput(ENTER);
      this.requestRender?.();
    };
    this.searchInput.onEscape = () => this.#leaveSearch();
  }

  get focused() {
    return this._focused;
  }

  set focused(value) {
    this._focused = value;
    this.searchInput.focused = value && this.mode === 'search';
  }

  /** Current incremental-search query (empty outside search mode). */
  get query() {
    return this.mode === 'search' ? this.searchInput.getValue() : '';
  }

  handleInput(data) {
    if (this.mode === 'search') {
      this.#searchInput(data);
      return;
    }
    if (typeof this.onKey === 'function' && this.onKey(data) === true) {
      this.requestRender?.();
      return;
    }
    if (isEscape(data)) {
      this.onCancel?.();
      return;
    }
    if (data === ENTER || data === '\n') {
      this.list.handleInput(ENTER);
      this.requestRender?.();
      return;
    }
    if (isCtrlKey(data, 'p')) {
      this.#move(-1);
      return;
    }
    if (isCtrlKey(data, 'n')) {
      this.#move(1);
      return;
    }
    if (data === '/') {
      this.#enterSearch();
      return;
    }
    if (isPrintableInput(data)) {
      this.#enterSearch();
      this.searchInput.handleInput(data);
      this.#syncFilter();
      return;
    }
    this.list.handleInput(data);
    this.requestRender?.();
  }

  #move(delta) {
    this.list.handleInput(delta < 0 ? UP : DOWN);
    this.requestRender?.();
  }

  #enterSearch() {
    this.mode = 'search';
    this.searchInput.setValue('');
    this.searchInput.focused = this._focused;
    this.list.setFilter('');
    this.requestRender?.();
  }

  #leaveSearch() {
    this.mode = 'nav';
    this.searchInput.setValue('');
    this.searchInput.focused = false;
    this.list.setFilter('');
    this.requestRender?.();
  }

  #syncFilter() {
    this.list.setFilter(this.searchInput.getValue());
    this.requestRender?.();
  }

  #searchInput(data) {
    if (isEscape(data)) {
      this.onCancel?.();
      return;
    }
    // List navigation keeps its vim/Emacs bindings while the caret stays in
    // the search input for IME and text editing.
    if (isUp(data) || isCtrlKey(data, 'p')) {
      this.#move(-1);
      return;
    }
    if (isDown(data) || isCtrlKey(data, 'n')) {
      this.#move(1);
      return;
    }
    this.searchInput.handleInput(data);
    if (this.mode === 'search') this.#syncFilter();
  }

  render(width) {
    const inner = Math.max(1, width - 6);
    const out = [];
    if (this.mode === 'search') {
      out.push(`${accent('/')} ${faint('search')}`);
      out.push(...this.searchInput.render(inner));
    } else {
      out.push(faint('/ search · ctrl+p/n or ↑↓ move · type filters'));
      out.push('');
    }
    out.push(...this.list.render(inner));
    out.push('');
    const footer = this.mode === 'search'
      ? 'enter select · ctrl+p/n move · ctrl+u clear · esc close'
      : `enter select · esc cancel${this.hint === '' ? '' : ` · ${this.hint}`}`;
    out.push(faint(footer));
    return boxed(out, width, this.title);
  }
}

/** Approval reasons may be a string or a localized `{ en, zh, ... }` map. */
function approvalReasonText(value) {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return '';
  for (const key of ['zh', 'zh-Hans', 'zh-CN', 'en']) {
    if (typeof value[key] === 'string' && value[key].trim() !== '') return value[key];
  }
  for (const candidate of Object.values(value)) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return '';
}

/** Extract the human-facing command without the tool card's one-line truncation. */
function approvalCommandText(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  try {
    const parsed = JSON.parse(value);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of ['command', 'cmd', 'script', 'path', 'file_path', 'query', 'url', 'pattern', 'objective']) {
        if (typeof parsed[key] === 'string' && parsed[key].trim() !== '') return parsed[key];
      }
    }
  } catch {
    // Non-JSON tool arguments are already the command text.
  }
  return value;
}

/** One approval prompt; y/enter allows once, n/esc rejects, d/e opens details. */
export class ApprovalPanel {
  constructor(request, detail, answer, { onDetails, rawDetail } = {}) {
    this.request = request;
    this.detail = detail;
    this.answer = answer;
    this.onDetails = onDetails;
    this.rawDetail = rawDetail ?? '';
    this.focused = false;
  }

  handleInput(data) {
    if (data === 'd' || data === 'D' || data === 'e' || data === 'E') {
      this.onDetails?.();
      return;
    }
    if (data === 'y' || data === 'Y' || data === '\r' || data === '\n') {
      this.answer('allowed-once');
      return;
    }
    if (data === 'n' || data === 'N' || isEscape(data)) this.answer('rejected');
  }

  /** Full, untruncated material for the scrollable details view. */
  detailsSections() {
    const reason = sanitizeText(
      approvalReasonText(this.request.displayReason) || approvalReasonText(this.request.reason),
    );
    const command = sanitizeText(approvalCommandText(this.rawDetail) || this.detail || this.rawDetail || '');
    const raw = sanitizeText(this.rawDetail);
    const sections = [
      { label: 'Request', text: reason || '(no request text)' },
      { label: 'Command', text: command || '(no command captured)' },
    ];
    if (raw !== '' && raw !== command) sections.push({ label: 'Full arguments', text: raw });
    return sections;
  }

  render(width) {
    const inner = Math.max(1, width - 6);
    const tool = sanitizeText(this.request.toolName ?? 'tool');
    const out = [`${yellow('▲')} ${bold(tool)}`];
    const reason = sanitizeText(
      approvalReasonText(this.request.displayReason) || approvalReasonText(this.request.reason),
    );
    if (reason.trim() !== '') {
      for (const line of wrap(reason, inner)) out.push(line);
    }
    const detail = sanitizeText(approvalCommandText(this.rawDetail) || this.detail || this.rawDetail || '');
    if (detail.trim() !== '') {
      out.push(faint('command'));
      for (const line of wrap(detail, inner).slice(0, 8)) out.push(`  ${gray(line)}`);
    }
    out.push('');
    out.push(
      `${green('[y]')} allow once    ${red('[n]')} reject${this.onDetails ? `    ${accent('[d]')} details` : ''}`,
    );
    return boxed(out, width, 'Approval required');
  }
}

/**
 * Read-only, scrollable approval details. Long request text and commands are
 * wrapped in full instead of being clipped to the approval panel's preview.
 */
export class ApprovalDetailsPanel {
  constructor(title, sections, { onClose, requestRender } = {}) {
    this.title = title;
    this.sections = Array.isArray(sections) ? sections : [];
    this.onClose = onClose;
    this.requestRender = requestRender;
    this.focused = false;
    this.scroll = 0;
    this.maxScroll = 0;
    this.page = 1;
    this.cachedWidth = null;
    this.cachedLines = null;
  }

  handleInput(data) {
    if (isEscape(data) || data === 'q' || data === 'Q') {
      this.onClose?.();
      return;
    }
    if (isUp(data) || isCtrlKey(data, 'p')) {
      this.#scrollBy(-1);
      return;
    }
    if (isDown(data) || isCtrlKey(data, 'n')) {
      this.#scrollBy(1);
      return;
    }
    const page = Math.max(1, this.page - 2);
    if (matchesKey(data, 'pageup') || isCtrlKey(data, 'u')) {
      this.#scrollBy(-page);
    } else if (matchesKey(data, 'pagedown') || isCtrlKey(data, 'd')) {
      this.#scrollBy(page);
    } else if (matchesKey(data, 'home') || data === 'g') {
      this.#scrollTo(0);
    } else if (matchesKey(data, 'end') || data === 'G') {
      this.#scrollTo(this.maxScroll);
    }
  }

  #scrollBy(delta) {
    this.#scrollTo(this.scroll + delta);
  }

  #scrollTo(value) {
    const next = Math.max(0, Math.min(this.maxScroll, value));
    if (next === this.scroll) return;
    this.scroll = next;
    this.requestRender?.();
  }

  #buildLines(width) {
    if (this.cachedWidth === width && this.cachedLines !== null) return this.cachedLines;
    const inner = Math.max(1, width - 6);
    const lines = [];
    for (const section of this.sections) {
      if (lines.length > 0) lines.push('');
      lines.push(bold(accent(sanitizeText(section.label ?? 'Details'))));
      const text = sanitizeText(section.text ?? '');
      if (text.trim() === '') {
        lines.push(`  ${faint('(empty)')}`);
        continue;
      }
      for (const line of wrap(text, Math.max(1, inner - 2))) lines.push(`  ${line}`);
    }
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  render(width) {
    const rows = Math.max(8, process.stdout.rows ?? 24);
    // Leave room for the box borders, the blank line, and the footer while
    // staying inside the overlay's 85% height budget.
    const page = Math.max(4, Math.min(30, Math.floor(rows * 0.85) - 4));
    const lines = this.#buildLines(width);
    this.page = page;
    this.maxScroll = Math.max(0, lines.length - page);
    this.scroll = Math.min(this.scroll, this.maxScroll);
    const body = lines.slice(this.scroll, this.scroll + page);
    if (lines.length > page) {
      while (body.length < page) body.push('');
    }
    const end = Math.min(lines.length, this.scroll + page);
    const position = lines.length > page ? `lines ${this.scroll + 1}-${end}/${lines.length} · ` : '';
    return boxed(
      [...body, '', faint(`${position}read-only · ↑/↓ pgup/pgdn · esc/q close`)],
      width,
      sanitizeText(this.title ?? 'Approval details'),
    );
  }
}

/**
 * Read-only live job output. The app owns polling and passes the accumulated
 * text; this component owns wrapping, scrolling and the kill prompt.
 */
export class JobOutputPanel {
  constructor(title, { onClose, onKill, requestRender } = {}) {
    this.title = title;
    this.onClose = onClose;
    this.onKill = onKill;
    this.requestRender = requestRender;
    this.focused = false;
    this.text = '';
    this.command = '';
    this.commandKind = '';
    this.footer = '';
    this.killArmed = false;
    this.killable = true;
    this.scroll = 0;
    this.follow = true;
    this.maxScroll = 0;
    this.page = 1;
    this.cachedWidth = null;
    this.cachedLines = null;
  }

  setText(text) {
    const next = typeof text === 'string' ? text : '';
    if (next === this.text) return;
    this.text = next;
    this.cachedLines = null;
    this.requestRender?.();
  }

  setCommand(command, kind = '') {
    const next = typeof command === 'string' ? command : '';
    const nextKind = typeof kind === 'string' ? kind : '';
    if (next === this.command && nextKind === this.commandKind) return;
    this.command = next;
    this.commandKind = nextKind;
    this.requestRender?.();
  }

  setTitle(title) {
    if (typeof title !== 'string' || title === this.title) return;
    this.title = title;
    this.requestRender?.();
  }

  setFooter(footer) {
    const next = typeof footer === 'string' ? footer : '';
    if (next === this.footer) return;
    this.footer = next;
    this.requestRender?.();
  }

  setKillArmed(armed) {
    const next = armed === true;
    if (next === this.killArmed) return;
    this.killArmed = next;
    this.requestRender?.();
  }

  setKillable(killable) {
    const next = killable === true;
    if (next === this.killable) return;
    this.killable = next;
    this.requestRender?.();
  }

  handleInput(data) {
    if (isEscape(data) || data === 'q' || data === 'Q') {
      this.onClose?.();
      return;
    }
    if (data === 'k' || data === 'K') {
      this.onKill?.();
      return;
    }
    if (isUp(data) || isCtrlKey(data, 'p')) {
      this.#scrollBy(-1);
      return;
    }
    if (isDown(data) || isCtrlKey(data, 'n')) {
      this.#scrollBy(1);
      return;
    }
    const page = Math.max(1, this.page - 2);
    if (matchesKey(data, 'pageup') || isCtrlKey(data, 'u')) {
      this.#scrollBy(-page);
    } else if (matchesKey(data, 'pagedown') || isCtrlKey(data, 'd')) {
      this.#scrollBy(page);
    } else if (matchesKey(data, 'home') || data === 'g') {
      this.#scrollTo(0);
    } else if (matchesKey(data, 'end') || data === 'G') {
      this.#scrollTo(this.maxScroll);
    }
  }

  #scrollBy(delta) {
    this.#scrollTo(this.scroll + delta);
  }

  #scrollTo(value) {
    const next = Math.max(0, Math.min(this.maxScroll, value));
    const previousFollow = this.follow;
    this.follow = next >= this.maxScroll;
    if (next === this.scroll && previousFollow === this.follow) return;
    this.scroll = next;
    this.requestRender?.();
  }

  #buildLines(width) {
    if (this.cachedWidth === width && this.cachedLines !== null) return this.cachedLines;
    const inner = Math.max(1, width - 6);
    const text = this.text === '' ? faint('(no output yet)') : this.text;
    const lines = wrap(text, Math.max(1, inner - 2)).map((line) => `  ${line}`);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  #commandLines(width) {
    const command = this.command.trim();
    if (command === '') return [];
    const inner = Math.max(1, width - 8);
    const clipped = command.length > 600 ? `${command.slice(0, 599)}…` : command;
    const wrapped = wrap(clipped, inner);
    const prefix = this.commandKind === 'bash' || this.commandKind === 'shell' ? '$' : '›';
    const shown = wrapped.slice(0, 3).map((line) => `  ${accent(prefix)} ${line}`);
    if (wrapped.length > 3) shown.push(faint(`  … ${wrapped.length - 3} more command line(s)`));
    return shown;
  }

  render(width) {
    const rows = Math.max(8, process.stdout.rows ?? 24);
    const page = Math.max(4, Math.min(30, Math.floor(rows * 0.85) - 4));
    const commandLines = this.#commandLines(width);
    const gap = commandLines.length === 0 ? 0 : 1;
    const bodyPage = Math.max(1, page - commandLines.length - gap);
    const lines = this.#buildLines(width);
    this.page = bodyPage;
    this.maxScroll = Math.max(0, lines.length - bodyPage);
    if (this.follow) this.scroll = this.maxScroll;
    this.scroll = Math.min(this.scroll, this.maxScroll);
    const body = lines.slice(this.scroll, this.scroll + bodyPage);
    while (body.length < bodyPage) body.push('');
    const end = Math.min(lines.length, this.scroll + bodyPage);
    const position = lines.length > bodyPage ? `lines ${this.scroll + 1}-${end}/${lines.length} · ` : '';
    const armed = this.killArmed ? 'press k again to stop · ' : '';
    const hint = ` ↑/↓ pgup/pgdn · ${this.onKill === undefined || !this.killable ? '' : 'k stop · '}esc/q close`;
    return boxed(
      [
        ...commandLines,
        ...(gap === 0 ? [] : ['']),
        ...body,
        '',
        faint(`${this.footer === '' ? '' : `${this.footer} · `}${armed}${position}${this.follow ? 'following' : 'scrolled'}${hint}`),
      ],
      width,
      sanitizeText(this.title),
    );
  }
}

/**
 * Sequential question flow: each question gets an option list and an optional
 * free-text escape hatch. Answers are sent as one batch.
 */
export class QuestionPanel {
  constructor(request, { onSubmit, onCancel, requestRender } = {}) {
    this.request = request;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
    this.requestRender = requestRender;
    this.questions = Array.isArray(request.questions) ? request.questions : [];
    this.answers = this.questions.map((question) => ({ id: question.id, selected: [], custom: '' }));
    this.index = 0;
    this.highlight = 0;
    this.mode = 'options';
    this._focused = false;
    this.input = new Input();
    this.input.onSubmit = (value) => {
      this.answers[this.index].custom = value.trim();
      this.input.setValue('');
      this.mode = 'options';
      this.input.focused = false;
      this.advance();
    };
    this.input.onEscape = () => {
      this.mode = 'options';
      this.input.focused = false;
      this.requestRender?.();
    };
  }

  get question() {
    return this.questions[this.index];
  }

  get focused() {
    return this._focused;
  }

  set focused(value) {
    this._focused = value;
    this.input.focused = value && this.mode === 'custom';
  }

  handleInput(data) {
    if (this.mode === 'custom') {
      this.input.handleInput(data);
      this.requestRender?.();
      return;
    }
    if (isEscape(data)) {
      this.onCancel?.();
      return;
    }
    const question = this.question;
    const options = Array.isArray(question?.options) ? question.options : [];
    if (isUp(data) || isCtrlKey(data, 'p')) {
      this.highlight = Math.max(0, this.highlight - 1);
      this.requestRender?.();
      return;
    }
    if (isDown(data) || isCtrlKey(data, 'n')) {
      this.highlight = Math.min(Math.max(0, options.length - 1), this.highlight + 1);
      this.requestRender?.();
      return;
    }
    if (data === ' ') {
      this.toggle();
      return;
    }
    if (data === 'c' || data === 'C') {
      this.enterCustom();
      return;
    }
    if (data === 's' || data === 'S') {
      this.onSubmit?.({ answers: this.skippedAnswers(), skipped: true });
      return;
    }
    if (data === '\r' || data === '\n') {
      if (options.length === 0) {
        this.enterCustom();
        return;
      }
      if (question?.multiSelect !== true) {
        this.answers[this.index].selected = [options[this.highlight].label];
      }
      this.advance();
      return;
    }
    if (/^[1-9]$/u.test(data)) {
      const index = Number(data) - 1;
      if (index < options.length) {
        this.highlight = index;
        if (question?.multiSelect === true) this.toggle();
        else this.answers[this.index].selected = [options[index].label];
        this.requestRender?.();
      }
    }
  }

  toggle() {
    const question = this.question;
    const options = Array.isArray(question?.options) ? question.options : [];
    const option = options[this.highlight];
    if (option === undefined) return;
    const answer = this.answers[this.index];
    if (question?.multiSelect === true) {
      answer.selected = answer.selected.includes(option.label)
        ? answer.selected.filter((label) => label !== option.label)
        : [...answer.selected, option.label];
    } else {
      answer.selected = [option.label];
    }
    this.requestRender?.();
  }

  enterCustom() {
    this.mode = 'custom';
    this.input.setValue(this.answers[this.index].custom ?? '');
    this.input.focused = true;
    this.requestRender?.();
  }

  advance() {
    if (this.index + 1 < this.questions.length) {
      this.index += 1;
      this.highlight = 0;
      this.mode = 'options';
      this.input.focused = false;
      this.requestRender?.();
      return;
    }
    this.submit();
  }

  skippedAnswers() {
    return this.questions.map((question) => ({ id: question.id, selected: [] }));
  }

  submit() {
    const answers = this.questions.map((question, index) => {
      const answer = this.answers[index];
      const custom = typeof answer.custom === 'string' ? answer.custom.trim() : '';
      if (question?.multiSelect === true) {
        return { id: answer.id, selected: [...answer.selected], ...(custom === '' ? {} : { custom }) };
      }
      if (custom !== '') return { id: answer.id, selected: [], custom };
      return { id: answer.id, selected: answer.selected.slice(0, 1) };
    });
    this.onSubmit?.({ answers });
  }

  render(width) {
    const inner = Math.max(1, width - 6);
    const question = this.question ?? {};
    const options = Array.isArray(question.options) ? question.options : [];
    const out = [];
    const header = question.header === undefined ? '' : ` ${faint('·')} ${bold(sanitizeText(question.header))}`;
    out.push(`${accent('?')} ${faint(`${this.index + 1}/${this.questions.length}`)}${header}`);
    if (question.intent?.kind === 'plan-review') out.push(`${yellow('plan review')}`);
    for (const line of wrap(question.question ?? '', inner)) out.push(line);
    if (typeof question.detail === 'string' && question.detail.trim() !== '') {
      for (const line of wrap(italic(gray(sanitizeText(question.detail))), inner).slice(0, 12)) out.push(line);
    }
    if (options.length > 0) {
      out.push('');
      options.forEach((option, index) => {
        const selected = this.answers[this.index].selected.includes(option.label);
        const marker = question.multiSelect === true ? (selected ? '◉' : '○') : selected ? '●' : '○';
        const cursor = index === this.highlight ? accent('›') : ' ';
        const label = index === this.highlight ? bold(sanitizeText(option.label)) : sanitizeText(option.label);
        const description = typeof option.description === 'string' && option.description !== '' ? ` ${faint(sanitizeText(option.description))}` : '';
        out.push(truncateToWidth(`${cursor} ${marker} ${index + 1}. ${label}${description}`, inner));
      });
    }
    if (this.mode === 'custom') {
      out.push('');
      out.push(faint('your answer'));
      const inputLines = this.input.render(inner);
      out.push(...inputLines);
    }
    out.push('');
    out.push(faint(options.length > 0 ? 'ctrl+p/n or ↑↓ move · space toggle · enter next · c custom · s skip · esc dismiss' : 'enter type answer · s skip · esc dismiss'));
    return boxed(out, width, `Question ${this.index + 1}/${this.questions.length}`);
  }
}

/** Focusable container used when a panel wraps a FilterList. */
export class PickerContainer extends Container {
  constructor(panel) {
    super();
    this.panel = panel;
    this.addChild(panel);
    this._focused = false;
  }

  get focused() {
    return this._focused;
  }

  set focused(value) {
    this._focused = value;
    this.panel.focused = value;
  }

  handleInput(data) {
    this.panel.handleInput(data);
  }
}
