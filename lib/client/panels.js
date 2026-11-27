/** Modal panels used by the attach TUI. */
import { Container, Input, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { accent, bold, faint, gray, green, italic, markdownTheme, red, selectTheme, yellow } from './theme.js';
import { sanitizeText } from './transcript.js';
import { approvalReasonText } from '../shared/approval.js';
import { describeSessionRule, isFilesystemRoot, sessionRuleFrom } from '../shared/session-allow.js';
import { approvalExtraSections, approvalRisk } from './approval-context.js';
import { fitRight } from './layout.js';
import { boxed } from './panel-frame.js';
import { OverlayPanel } from './overlay-panel.js';
import { nextSelectionIndex } from './scroll.js';
import {
  DOWN,
  ENTER,
  UP,
  isCtrlKey,
  isDown,
  wheelDirection,
  isEscape,
  isLeft,
  isRight,
  isUp,
} from './keys.js';

function wrap(text, width) {
  if (width <= 0) return [''];
  return wrapTextWithAnsi(sanitizeText(text), width);
}

/** Scrollable information panel; `F` maximizes and `c` copies raw text. */
export class InfoPanel extends OverlayPanel {
  constructor(title, lines, onClose, options = {}) {
    super({ ...options, title, onClose, fill: options.fill ?? false });
    this.lines = Array.isArray(lines) ? lines : [];
  }

  setLines(lines) {
    this.lines = Array.isArray(lines) ? lines : [];
  }

  contentLines(width) {
    const inner = Math.max(1, width - 6);
    const out = [];
    for (const line of this.lines) {
      if (line === '') {
        out.push('');
        continue;
      }
      for (const wrapped of wrap(line, inner)) out.push(wrapped);
    }
    return out;
  }

  footerLines() {
    return [faint(`esc close · ${this.positionLabel()}F fullscreen · c copy`)];
  }

  copyText() {
    return this.lines.map((line) => sanitizeText(String(line ?? ''))).join('\n');
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

/** Render a fixed-width column block after a flexible left label. */
function fitItemColumns(left, columns, width) {
  if (!Array.isArray(columns) || columns.length === 0) return truncateToWidth(left, width);
  const columnsWidth = columns.reduce((sum, column) => sum + column.width, 0) + Math.max(0, columns.length - 1) * 2;
  if (columnsWidth >= width) {
    return truncateToWidth(columns.map((column) => truncateToWidth(column.text, column.width)).join('  '), width);
  }
  const leftWidth = Math.max(1, width - columnsWidth - 2);
  const head = truncateToWidth(left, leftWidth);
  const gap = ' '.repeat(Math.max(1, width - visibleWidth(head) - columnsWidth));
  const rendered = columns.map((column) => {
    const text = truncateToWidth(column.text, column.width);
    const padding = ' '.repeat(Math.max(0, column.width - visibleWidth(text)));
    return column.align === 'right' ? `${padding}${text}` : `${text}${padding}`;
  });
  const row = `${head}${gap}${rendered.join('  ')}`;
  return `${row}${' '.repeat(Math.max(0, width - visibleWidth(row)))}`;
}

/** Preserve both ends of a path when a flexible column is narrow. */
function truncateMiddle(text, width) {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return '…';
  const headWidth = Math.floor((width - 1) / 2);
  const tailWidth = width - 1 - headWidth;
  const head = text.slice(0, headWidth);
  const tail = text.slice(Math.max(0, text.length - tailWidth));
  return `${head}…${tail}`;
}

/** Render a fixed title column followed immediately by fixed columns. */
function fitItemTable(left, titleWidth, columns, width, theme) {
  if (!Array.isArray(columns) || columns.length === 0) return truncateToWidth(left, width);
  const gaps = Math.max(0, columns.length - 1) * 2;
  const fixedWidth = columns.reduce((sum, column) => sum + (column.flex === true ? 0 : column.width), 0) + gaps;
  const actualTitle = Math.min(titleWidth, Math.max(1, width - fixedWidth - 2 - 8));
  const flexWidth = Math.max(8, width - actualTitle - fixedWidth - 2);
  const head = truncateToWidth(left, actualTitle);
  const title = `${head}${' '.repeat(Math.max(0, actualTitle - visibleWidth(head)))}  `;
  const rendered = columns.map((column) => {
    const columnWidth = column.flex === true ? flexWidth : column.width;
    const raw = column.ellipsis === 'middle' ? truncateMiddle(column.text, columnWidth) : truncateToWidth(column.text, columnWidth);
    const text = theme?.description ? theme.description(raw) : raw;
    const padding = ' '.repeat(Math.max(0, columnWidth - visibleWidth(text)));
    return column.align === 'right' ? `${padding}${text}` : `${text}${padding}`;
  });
  const row = `${title}${rendered.join('  ')}`;
  const padded = `${row}${' '.repeat(Math.max(0, width - visibleWidth(row)))}`;
  return truncateToWidth(padded, width);
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
    const columns = Array.isArray(item.columns) ? item.columns.map((column) => column.text).join('\n') : '';
    return `${item.label}\n${item.description ?? ''}\n${item.meta ?? ''}\n${columns}\n${item.value ?? ''}`.toLowerCase();
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
        if (session.groupKey === undefined) {
          if (matchedSessions.has(session)) visible.add(session);
          continue;
        }
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

  /** Apply page/home/end keys to the selection; false leaves the key alone. */
  handlePageInput(data) {
    const next = nextSelectionIndex(data, {
      index: this.selectedIndex,
      length: this.filtered.length,
      page: this.maxVisible,
    });
    if (next === null) return false;
    this.setSelectedIndex(next);
    this.onSelectionChange?.(this.getSelectedItem());
    return true;
  }

  handleInput(data) {
    if (this.handlePageInput(data)) return;
    if (isUp(data) || isCtrlKey(data, 'p')) this.move(-1);
    else if (isDown(data) || isCtrlKey(data, 'n')) this.move(1);
    else if (isLeft(data)) this.#horizontal(-1);
    else if (isRight(data)) this.#horizontal(1);
    else if (data === '\r' || data === '\n') this.select();
    else if (isEscape(data)) this.onCancel?.();
  }

  #tableLayout() {
    const tableItems = this.filtered.filter((item) => item.table === true && Array.isArray(item.columns));
    if (tableItems.length === 0) return null;
    const maxLabel = Math.max(...tableItems.map((item) => visibleWidth(sanitizeText(item.label)) + 4));
    return { titleWidth: Math.max(24, Math.min(44, maxLabel)) };
  }

  render(width) {
    if (this.filtered.length === 0) return [this.theme.noMatch('  no match')];
    const tableLayout = this.#tableLayout();
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
        const indent = item.flat === true ? '' : '  '.repeat(Math.max(1, item.depth ?? 1));
        const dot = item.running === true ? `${green('●')} ` : `${faint('○')} `;
        const current = item.current === true ? ` ${accent('★')}` : '';
        const label = `${indent}${dot}${sanitizeText(item.label)}${current}`;
        body = selected ? this.theme.selectedText(label) : label;
      } else {
        body = selected ? this.theme.selectedText(sanitizeText(item.label)) : sanitizeText(item.label);
      }
      if (Array.isArray(item.columns) && item.columns.length > 0) {
        const columns = item.columns.map((column) => ({ ...column, text: sanitizeText(column.text) }));
        lines.push(item.table === true
          ? fitItemTable(`${prefix}${body}`, tableLayout?.titleWidth ?? item.titleWidth ?? 26, columns, width, this.theme)
          : fitItemColumns(`${prefix}${body}`, columns.map((column) => ({
              ...column,
              text: this.theme.description(column.text),
            })), width));
        continue;
      }
      const description = item.description === undefined ? '' : `  ${this.theme.description(sanitizeText(item.description))}`;
      if (meta !== '') {
        // Flat session rows keep their context on the left and right-align
        // mutable facts such as age and agent counts.
        const left = item.flat === true ? `${prefix}${body}${description}` : `${prefix}${body}`;
        lines.push(fitRight(left, meta, width));
        continue;
      }
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
  constructor(title, list, { onCancel, requestRender, hint = '', onKey, preview } = {}) {
    this.title = title;
    this.list = list;
    this.onCancel = onCancel;
    this.requestRender = requestRender;
    this.hint = typeof hint === 'string' ? hint : '';
    this.onKey = onKey;
    this.preview = typeof preview === 'function' ? preview : null;
    this._focused = false;
    this.mode = 'nav';
    this.fullscreen = false;
    this.windowedMaxVisible = list.maxVisible;
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
    if (data === 'F') {
      this.fullscreen = !this.fullscreen;
      this.list.maxVisible = this.fullscreen
        ? Math.max(this.windowedMaxVisible, Math.max(10, (process.stdout.rows ?? 24) - 10))
        : this.windowedMaxVisible;
      this.onToggleFullscreen?.(this.fullscreen);
      this.requestRender?.();
      return;
    }
    const wheel = wheelDirection(data);
    if (wheel !== 0) {
      this.#move(wheel);
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
    const wheel = wheelDirection(data);
    if (wheel !== 0) {
      this.#move(wheel);
      return;
    }
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
    if (matchesKey(data, 'pageup') || matchesKey(data, 'pagedown')) {
      if (this.list.handlePageInput(data)) this.requestRender?.();
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
      out.push(faint('/ search · ctrl+p/n or ↑↓ move · pgup/pgdn · type filters'));
      out.push('');
    }
    out.push(...this.list.render(inner));
    const preview = this.preview === null ? '' : this.preview(this.list.getSelectedItem());
    if (typeof preview === 'string' && preview !== '') {
      out.push('');
      out.push(...wrap(preview, inner));
    }
    out.push('');
    const footer = this.mode === 'search'
      ? 'enter select · ctrl+p/n or pgup/pgdn move · ctrl+u clear · esc close'
      : `enter select · esc cancel${this.hint === '' ? '' : ` · ${this.hint}`}`;
    out.push(faint(footer));
    return boxed(out, width, this.title, { sideBorders: !this.fullscreen });
  }
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

/**
 * One approval prompt.
 *
 * `y`/`n` answer once, `s` derives a session-scoped rule and allows, `a`
 * previews the same rule for the durable auto-approval file, `r` rejects and
 * lets the human add guidance, `w` grants the target's parent directory as a
 * session writable root, `d`/`e`/`enter` opens details, and `esc` detaches.
 */
export class ApprovalPanel extends OverlayPanel {
  constructor(request, detail, answer, {
    onDetails,
    onDetach,
    rawDetail,
    context,
    onSessionAllow,
    onAlwaysAllow,
    onRejectNote,
    onRegisterDir,
    requestRender,
  } = {}) {
    super({
      title: 'Approval required',
      onClose: onDetach,
      requestRender,
      fill: false,
      scrollEnabled: false,
    });
    this.request = request;
    this.detail = detail;
    this.answer = answer;
    this.onDetails = onDetails;
    this.onDetach = onDetach;
    this.rawDetail = rawDetail ?? '';
    this.context = context ?? {};
    this.onSessionAllow = onSessionAllow;
    this.onAlwaysAllow = onAlwaysAllow;
    this.onRejectNote = onRejectNote;
    this.onRegisterDir = onRegisterDir;
  }

  #reasonText() {
    return sanitizeText(
      approvalReasonText(this.request.displayReason) || approvalReasonText(this.request.reason),
    );
  }

  /** The parsed tool arguments, or null when they are not a JSON object. */
  #parsedArgs() {
    let args;
    try {
      args = JSON.parse(this.rawDetail);
    } catch {
      return null;
    }
    return args !== null && typeof args === 'object' && !Array.isArray(args) ? args : null;
  }

  /** Parsed context for deriving a session rule, or null. */
  #ruleContext() {
    const args = this.#parsedArgs();
    if (args === null) return null;
    return {
      toolName: this.request.toolName ?? 'tool',
      cwd: this.context.cwd,
      arguments: args,
      currentSandbox: this.context.permission,
      requestedSandbox: typeof args.sandbox_permissions === 'string' ? args.sandbox_permissions : null,
    };
  }

  /** The narrow rule that `s`/`a` would use, or null when none is derivable. */
  sessionRule() {
    return sessionRuleFrom(this.#ruleContext());
  }

  /** Sandbox/target/justification facts shown on the main card. */
  risk() {
    return approvalRisk(this.rawDetail, { ...this.context, reason: this.#reasonText() });
  }

  canRegisterDir(risk = this.risk()) {
    if (typeof this.onRegisterDir !== 'function') return false;
    if (this.context.sandboxRoots === false) return false;
    if (this.context.permission !== 'workspace-write') return false;
    if (risk.outsideWorkspace !== true) return false;
    if (risk.parentDirectory === '' || isFilesystemRoot(risk.parentDirectory)) return false;
    // Only a file tool: an approval carrying a non-empty shell command never
    // describes one directory to grant.
    const args = this.#parsedArgs();
    if (args === null) return false;
    return !(typeof args.command === 'string' && args.command.trim() !== '');
  }

  handlePanelInput(data) {
    if (data === 'd' || data === 'D' || data === 'e' || data === 'E' || data === '\r' || data === '\n') {
      this.onDetails?.();
      return true;
    }
    if (data === 'y' || data === 'Y') {
      this.answer('allowed-once');
      return true;
    }
    if (data === 'n' || data === 'N') {
      this.answer('rejected');
      return true;
    }
    if (data === 's' || data === 'S') {
      if (typeof this.onSessionAllow !== 'function') return false;
      const rule = this.sessionRule();
      if (rule === null) return false;
      this.onSessionAllow(rule);
      return true;
    }
    if (data === 'a' || data === 'A') {
      if (typeof this.onAlwaysAllow !== 'function') return false;
      const rule = this.sessionRule();
      if (rule === null) return false;
      this.onAlwaysAllow(rule);
      return true;
    }
    if (data === 'r' || data === 'R') {
      if (typeof this.onRejectNote !== 'function') return false;
      this.onRejectNote();
      return true;
    }
    if (data === 'w' || data === 'W') {
      const risk = this.risk();
      if (!this.canRegisterDir(risk)) return false;
      this.onRegisterDir(risk.parentDirectory);
      return true;
    }
    return false;
  }

  /** Full, untruncated material for the scrollable details view. */
  detailsSections() {
    const reason = this.#reasonText();
    const command = sanitizeText(approvalCommandText(this.rawDetail) || this.detail || this.rawDetail || '');
    const raw = sanitizeText(this.rawDetail);
    const risk = this.risk();
    const riskLines = [];
    if (risk.escalates) riskLines.push(`sandbox: ${risk.currentSandbox === '' ? '(unknown)' : risk.currentSandbox} → ${risk.requestedSandbox}${risk.fullAccess ? ' (entire user-accessible filesystem)' : ''}`);
    else if (risk.requestedSandbox !== '') riskLines.push(`requested sandbox: ${risk.requestedSandbox}`);
    if (risk.target !== '') {
      riskLines.push(`target: ${sanitizeText(risk.target)}${risk.outsideWorkspace ? ' (outside the workspace)' : ''}`);
    }
    if (risk.justification !== '') riskLines.push(`justification: ${sanitizeText(risk.justification)}`);
    const rule = this.sessionRule();
    const sections = [
      { label: 'Request', text: reason || '(no request text)' },
      ...(riskLines.length === 0 ? [] : [{ label: 'Risk', text: riskLines.join('\n') }]),
      { label: 'Command', text: command || '(no command captured)' },
      ...approvalExtraSections(raw, this.context),
      ...(rule === null || typeof this.onSessionAllow !== 'function'
        ? []
        : [{ label: 'Session rule', text: describeSessionRule(rule) }]),
    ];
    if (raw !== '' && raw !== command) sections.push({ label: 'Full arguments', text: raw });
    return sections;
  }

  copyText() {
    return this.detailsSections().map((section) => `${section.label}\n${section.text}`).join('\n\n');
  }

  contentLines(width) {
    const inner = Math.max(1, width - 6);
    const tool = sanitizeText(this.request.toolName ?? 'tool');
    const out = [`${yellow('▲')} ${bold(tool)}`];
    const reason = this.#reasonText();
    if (reason.trim() !== '') {
      for (const line of wrap(reason, inner)) out.push(line);
    }
    const risk = this.risk();
    if (risk.escalates) {
      const arrow = `${risk.currentSandbox === '' ? '(unknown)' : risk.currentSandbox} → ${risk.requestedSandbox}`;
      out.push(risk.fullAccess ? red(`⚠ sandbox escalation: ${arrow} (full access)`) : yellow(`⚠ sandbox escalation: ${arrow}`));
    } else if (risk.fullAccess) {
      out.push(red('⚠ danger-full-access: every path this user can access'));
    }
    if (risk.justification !== '') {
      out.push(faint('why'));
      for (const line of wrap(risk.justification, inner).slice(0, 4)) out.push(`  ${yellow(line)}`);
    }
    if (risk.target !== '') {
      const target = sanitizeText(risk.target);
      const resolved = sanitizeText(risk.resolvedTarget);
      const marker = risk.outsideWorkspace ? red('  ⚠ outside workspace') : '';
      out.push(faint(`target ${target}`) + marker);
      if (resolved !== '' && resolved !== target) {
        out.push(`  ${gray(resolved)}`);
      }
    }
    const detail = sanitizeText(approvalCommandText(this.rawDetail) || this.detail || this.rawDetail || '');
    if (detail.trim() !== '') {
      out.push(faint('command'));
      for (const line of wrap(detail, inner).slice(0, 8)) out.push(`  ${gray(line)}`);
    }
    const rule = this.sessionRule();
    if (rule !== null && typeof this.onSessionAllow === 'function') {
      const description = sanitizeText(describeSessionRule(rule));
      if (description !== '') {
        out.push('');
        out.push(`${faint('this session would allow')} ${rule.allowFullAccess === true ? red(description) : gray(description)}`);
      }
    }
    return out;
  }

  footerLines() {
    const rule = this.sessionRule();
    const danger = rule?.allowFullAccess === true;
    const session = rule !== null && typeof this.onSessionAllow === 'function'
      ? `    ${green('[s]')} session${danger ? ` ${red('DANGER')}` : ''}`
      : '';
    const always = rule !== null && typeof this.onAlwaysAllow === 'function'
      ? `    ${green('[a]')} always${danger ? ` ${red('DANGER')}` : ''}`
      : '';
    const note = typeof this.onRejectNote === 'function' ? `    ${accent('[r]')} reject+note` : '';
    const directory = this.canRegisterDir() ? `${accent('[w]')} allow dir · ` : '';
    return [
      `${green('[y]')} allow once    ${red('[n]')} reject${session}${always}${note}`,
      faint(`${directory}${typeof this.onDetails === 'function' ? '[d] details · ' : ''}c copy · F fullscreen · esc detach`),
    ];
  }
}

/**
 * Read-only, scrollable approval details. The shared overlay base owns
 * scrolling, maximize and raw copying.
 */
export class ApprovalDetailsPanel extends OverlayPanel {
  constructor(title, sections, { onClose, requestRender, ...options } = {}) {
    super({ ...options, title, onClose, requestRender, pageRatio: 0.85 });
    this.sections = Array.isArray(sections) ? sections : [];
    this.cachedWidth = null;
    this.cachedLines = null;
  }

  contentLines(width) {
    return this.#buildLines(width);
  }

  footerLines() {
    return [faint(`${this.positionLabel()}read-only · ↑/↓ pgup/pgdn · F fullscreen · c copy`)];
  }

  copyText() {
    return this.sections.map((section) => {
      const label = sanitizeText(String(section.label ?? 'Details'));
      return `${label}\n${sanitizeText(String(section.text ?? ''))}`;
    }).join('\n\n');
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
}

/**
 * Read-only live job output. The app owns polling and passes accumulated text;
 * the shared overlay base owns scrolling, maximize and raw copying.
 */
export class JobOutputPanel extends OverlayPanel {
  constructor(title, { onClose, onKill, onDetails, requestRender, ...options } = {}) {
    super({ ...options, title, onClose, requestRender, pageRatio: 0.85, follow: true });
    this.onKill = onKill;
    this.onDetails = onDetails;
    this.text = '';
    this.command = '';
    this.commandKind = '';
    this.footer = '';
    this.killArmed = false;
    this.killable = true;
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

  handlePanelInput(data) {
    if (data === 'd' || data === 'D' || data === '\r' || data === '\n') {
      this.onDetails?.();
      return true;
    }
    if (data === 'k' || data === 'K') {
      this.onKill?.();
      return true;
    }
    return false;
  }

  copyText() {
    return this.text;
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
    const wrapped = wrap(command, inner);
    const prefix = this.commandKind === 'bash' || this.commandKind === 'shell' ? '$' : '›';
    return wrapped.map((line) => `  ${accent(prefix)} ${line}`);
  }

  contentLines(width) {
    const commandLines = this.#commandLines(width);
    return [...commandLines, ...(commandLines.length === 0 ? [] : ['']), ...this.#buildLines(width)];
  }

  footerLines() {
    const armed = this.killArmed ? 'press k again to stop · ' : '';
    const details = this.onDetails === undefined ? '' : 'enter/d full command · ';
    const hint = `↑/↓ pgup/pgdn · ${details}${this.onKill === undefined || !this.killable ? '' : 'k stop · '}esc/q close · F fullscreen · c copy`;
    return [faint(`${this.footer === '' ? '' : `${this.footer} · `}${armed}${this.positionLabel()}${this.follow ? 'following' : 'scrolled'}${hint}`)];
  }
}

/**
 * Sequential question flow: each question gets an option list and an optional
 * free-text escape hatch. Answers are sent as one batch.
 */
export class QuestionPanel extends OverlayPanel {
  constructor(request, { onSubmit, onCancel, requestRender, ...options } = {}) {
    super({
      ...options,
      title: 'Question',
      onClose: onCancel,
      requestRender,
      fill: false,
      copyKey: 'C',
    });
    this.request = request;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
    this.questions = Array.isArray(request.questions) ? request.questions : [];
    this.answers = this.questions.map((question) => ({ id: question.id, selected: [], custom: '' }));
    this.index = 0;
    this.highlight = 0;
    this.mode = this.#questionHasOptions(0) ? 'options' : 'custom';
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
      if (!this.#questionHasOptions(this.index)) {
        this.onCancel?.();
        return;
      }
      this.mode = 'options';
      this.input.focused = false;
      this.requestRender?.();
    };
  }

  #questionHasOptions(index) {
    const options = this.questions[index]?.options;
    return Array.isArray(options) && options.length > 0;
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

  handlePanelInput(data) {
    // A focused text input owns every printable key. In particular 'C' must
    // not reach the overlay's copy shortcut and 'F' must not toggle
    // fullscreen while the user is typing an answer.
    if (this.mode === 'custom') {
      if (matchesKey(data, 'pageup') || matchesKey(data, 'pagedown')) return false;
      this.input.handleInput(data);
      this.requestRender?.();
      return true;
    }
    if (data === 'F' || data === 'C'
      || matchesKey(data, 'pageup') || matchesKey(data, 'pagedown')
      || matchesKey(data, 'home') || matchesKey(data, 'end')) {
      return false;
    }
    if (isEscape(data)) {
      this.onCancel?.();
      return true;
    }
    const question = this.question;
    const options = Array.isArray(question?.options) ? question.options : [];
    if (isUp(data) || isCtrlKey(data, 'p')) {
      this.highlight = Math.max(0, this.highlight - 1);
      this.requestRender?.();
      return true;
    }
    if (isDown(data) || isCtrlKey(data, 'n')) {
      this.highlight = Math.min(Math.max(0, options.length - 1), this.highlight + 1);
      this.requestRender?.();
      return true;
    }
    if (data === ' ') {
      this.toggle();
      return true;
    }
    if (data === 'c' || data === 'C') {
      this.enterCustom();
      return true;
    }
    if (data === 's' || data === 'S') {
      this.onSubmit?.({ answers: this.skippedAnswers(), skipped: true });
      return true;
    }
    if (data === '\r' || data === '\n') {
      if (options.length === 0) {
        this.enterCustom();
        return true;
      }
      if (question?.multiSelect !== true) {
        this.answers[this.index].selected = [options[this.highlight].label];
      }
      this.advance();
      return true;
    }
    if (/^[1-9]$/u.test(data)) {
      const index = Number(data) - 1;
      if (index < options.length) {
        this.highlight = index;
        if (question?.multiSelect === true) this.toggle();
        else this.answers[this.index].selected = [options[index].label];
        this.requestRender?.();
      }
      return true;
    }
    return false;
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
      this.mode = this.#questionHasOptions(this.index) ? 'options' : 'custom';
      this.input.focused = this._focused && this.mode === 'custom';
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

  copyText() {
    const question = this.question ?? {};
    const options = Array.isArray(question.options) ? question.options : [];
    return [
      String(question.question ?? ''),
      ...(typeof question.detail === 'string' && question.detail !== '' ? [question.detail] : []),
      ...options.map((option) => option.label),
    ].join('\n');
  }

  contentLines(width) {
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
      out.push(...this.input.render(inner));
    }
    return out;
  }

  footerLines() {
    const options = Array.isArray(this.question?.options) ? this.question.options : [];
    const hasOptions = this.#questionHasOptions(this.index);
    return [faint(this.mode === 'custom'
      ? `enter submit · esc ${hasOptions ? 'back' : 'dismiss'} · pgup/pgdn scroll`
      : options.length > 0
        ? 'ctrl+p/n or ↑↓ move · space toggle · enter next · c custom · s skip · C copy · F fullscreen · esc dismiss'
        : 'enter type answer · esc dismiss')];
  }

  render(width) {
    this.title = `Question ${this.index + 1}/${this.questions.length}`;
    return super.render(width);
  }
}

export class ConfirmPanel extends OverlayPanel {
  constructor(title, lines, { onConfirm, onCancel, requestRender, confirmLabel = 'confirm', ...options } = {}) {
    super({ ...options, title, onClose: onCancel, requestRender, fill: false, scrollEnabled: false });
    this.lines = Array.isArray(lines) ? lines : [String(lines ?? '')];
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
    this.confirmLabel = confirmLabel;
  }

  handlePanelInput(data) {
    if (data === 'y' || data === 'Y') {
      this.onConfirm?.();
      return true;
    }
    if (data === 'n' || data === 'N' || data === '\r' || data === '\n') {
      this.onCancel?.();
      return true;
    }
    return false;
  }

  contentLines(width) {
    const inner = Math.max(1, width - 6);
    const out = [];
    for (const line of this.lines) {
      if (line === '') {
        out.push('');
        continue;
      }
      for (const wrapped of wrap(line, inner)) out.push(wrapped);
    }
    return out;
  }

  footerLines() {
    return [`${green('[y]')} ${sanitizeText(this.confirmLabel)}    ${faint('[n]')} cancel    ${faint('enter cancels')}${this.copyEnabled ? `    ${faint('c copy · F fullscreen')}` : ''}`];
  }

  copyText() {
    return this.lines.map((line) => sanitizeText(String(line ?? ''))).join('\n');
  }
}

/**
 * Single-line prompt used to edit a queued message or send a subagent follow-up.
 * `F` maximizes; copy is disabled because `c` is ordinary input.
 */
export class TextPromptPanel extends OverlayPanel {
  constructor(title, value, { onSubmit, onCancel, requestRender, hint = 'edit the queued message', submitVerb = 'save', ...options } = {}) {
    super({
      ...options,
      title,
      onClose: onCancel,
      requestRender,
      fill: false,
      scrollEnabled: false,
      copyEnabled: false,
    });
    this.hint = hint;
    this.submitVerb = submitVerb;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
    this.input = new Input();
    this.input.setValue(typeof value === 'string' ? value : '');
    this.input.onSubmit = (text) => this.onSubmit?.(text);
    this.input.onEscape = () => this.onCancel?.();
    this._focused = false;
  }

  get focused() {
    return this._focused;
  }

  set focused(value) {
    this._focused = value;
    this.input.focused = value;
  }

  handlePanelInput(data) {
    // This is a free-text field; 'F' is text, not the fullscreen shortcut.
    this.input.handleInput(data);
    this.requestRender?.();
    return true;
  }

  contentLines(width) {
    const inner = Math.max(1, width - 6);
    return [faint(this.hint), '', ...this.input.render(inner)];
  }

  footerLines() {
    return [faint(`enter ${this.submitVerb} · esc cancel`)];
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

  /** Forward the overlay frame callback to the panel that toggles it. */
  get onToggleFullscreen() {
    return this.panel.onToggleFullscreen;
  }

  set onToggleFullscreen(handler) {
    this.panel.onToggleFullscreen = handler;
  }

  handleInput(data) {
    this.panel.handleInput(data);
  }
}


/** Ephemeral /btw side-question card. */
export class BtwPanel extends OverlayPanel {
  constructor(entries, index = entries.length - 1, { onClose, onFork, onCancel, onClear, onCopy, onToggleFullscreen, fullscreen = false, requestRender } = {}) {
    super({
      title: 'Side question · /btw',
      onClose,
      onToggleFullscreen,
      requestRender,
      fullscreen,
      pageRatio: 0.75,
      follow: true,
      copyEnabled: false,
    });
    this.entries = entries;
    this.index = Math.max(0, Math.min(entries.length - 1, index));
    this.onFork = onFork;
    this.onCancel = onCancel;
    this.onClear = onClear;
    this.onCopy = onCopy;
    this.markdown = null;
    this.markdownText = '';
    this.markdownWidth = 0;
  }

  get entry() {
    return this.entries[this.index];
  }

  setIndex(index) {
    const next = Math.max(0, Math.min(this.entries.length - 1, index));
    if (next === this.index) return;
    this.index = next;
    this.scroll = 0;
    this.follow = true;
    this.invalidate();
    this.requestRender?.();
  }

  setEntries(entries, index = 0) {
    this.entries = entries;
    this.index = Math.max(0, Math.min(entries.length - 1, index));
    this.scroll = 0;
    this.follow = true;
    this.invalidate();
    this.requestRender?.();
  }

  setEntry(index, entry) {
    this.entries[index] = entry;
    if (index === this.index) this.invalidate();
    this.requestRender?.();
  }

  /** Drop rendered Markdown caches after the answer or its width changes. */
  invalidate() {
    this.markdown = null;
    this.markdownText = '';
    this.markdownWidth = 0;
  }

  #answerLines(text, width) {
    const value = sanitizeText(text ?? '');
    if (value === '') return [];
    if (this.markdown === null || this.markdownText !== value || this.markdownWidth !== width) {
      this.markdown = new Markdown(value, 0, 0, markdownTheme);
      this.markdownText = value;
      this.markdownWidth = width;
    }
    return this.markdown.render(width);
  }

  #statusOf(entry) {
    if (entry?.error === true) return 'error';
    return typeof entry?.status === 'string' ? entry.status : 'done';
  }

  #bodyLines(width) {
    const entry = this.entry;
    if (entry === undefined) return [];
    const inner = Math.max(1, width - 6);
    const lines = [];
    const question = entry.question ?? '';
    const questionLines = wrap(`/btw ${question}`, inner);
    for (const line of questionLines) lines.push(bold(line));
    lines.push('');

    const status = this.#statusOf(entry);
    const meta = [
      entry.provider !== null && entry.model !== null ? `${entry.provider}/${entry.model}` : '',
      status === 'answering' || status === 'cancelling' ? 'no tools' : '',
      typeof entry.startedAt === 'number' ? `${Math.max(0, Math.round((Date.now() - entry.startedAt) / 1000))}s` : '',
    ].filter((part) => part !== '');
    if (meta.length > 0 && status !== 'done') {
      lines.push(faint(meta.join(' · ')));
      lines.push('');
    }

    if (status === 'forking') {
      const child = typeof entry.fork?.childId === 'string' ? ` · ${entry.fork.childId.slice(0, 12)}` : '';
      lines.push(faint(`Forking to a full-tool subagent${child}…`));
      return lines;
    }
    if (status === 'fork-failed') {
      const error = entry.fork?.error || entry.answer || 'side question fork failed';
      for (const line of wrap(error, inner)) lines.push(red(line));
      return lines;
    }
    if (status === 'answering' || status === 'cancelling') {
      if (typeof entry.answer === 'string' && entry.answer !== '') {
        lines.push(...this.#answerLines(entry.answer, inner));
        lines.push('');
      }
      lines.push(faint(status === 'cancelling' ? 'Cancelling…' : 'Answering…'));
    } else if (status === 'error') {
      for (const line of wrap(entry.answer || 'side question failed', inner)) lines.push(red(line));
    } else if (status === 'cancelled') {
      lines.push(faint(entry.answer || 'Side question cancelled.'));
    } else {
      if (typeof entry.reasoning === 'string' && entry.reasoning !== '') {
        lines.push(faint(`thinking · ${entry.reasoning.length} chars`));
        lines.push('');
      }
      const answer = typeof entry.answer === 'string' ? entry.answer : '';
      if (answer === '') lines.push(faint('(no answer)'));
      else lines.push(...this.#answerLines(answer, inner));
    }
    return lines;
  }

  handlePanelInput(data) {
    const status = this.#statusOf(this.entry);
    const active = status === 'answering' || status === 'cancelling';
    if (isEscape(data)) {
      if (active) this.onCancel?.(this.entry);
      else this.onClose?.();
      return true;
    }
    if (data === ' ' || data === '\r' || data === '\n') {
      this.onClose?.();
      return true;
    }
    if (data === 'q' || data === 'Q') {
      this.onClose?.();
      return true;
    }
    if (data === 'c' || data === 'C') {
      this.onCopy?.(this.entry);
      return true;
    }
    if (data === 'x' || data === 'X') {
      this.onClear?.(this.entry);
      return true;
    }
    if (data === '[' || isLeft(data)) {
      this.setIndex(this.index - 1);
      return true;
    }
    if (data === ']' || isRight(data)) {
      this.setIndex(this.index + 1);
      return true;
    }
    if (data === 'f' && status === 'done') {
      this.onFork?.(this.entry);
      return true;
    }
    return false;
  }

  contentLines(width) {
    return this.#bodyLines(width);
  }

  footerLines() {
    const history = this.entries.length > 1 ? `${this.index + 1}/${this.entries.length} · [ ] history · ` : '';
    const status = this.#statusOf(this.entry);
    const active = status === 'answering' || status === 'cancelling';
    const forkAction = status === 'done' ? 'f fork with tools · ' : '';
    const copy = status === 'done' || status === 'cancelled' || status === 'forked' ? 'c copy · ' : '';
    const entry = this.entry;
    const forkStatus = entry?.fork?.status === 'running' && typeof entry.fork.childId === 'string'
      ? `fork ${entry.fork.childId.slice(0, 12)} running · `
      : entry?.fork?.status === 'done' && typeof entry.fork.childId === 'string'
        ? `fork ${entry.fork.childId.slice(0, 12)} done · `
        : '';
    const zoom = `F ${this.fullscreen ? 'windowed' : 'fullscreen'} · `;
    const help = active ? 'esc cancel · space close' : 'esc close';
    return [faint(`${this.positionLabel()}${history}${copy}${forkStatus}${forkAction}x clear · ${zoom}${help}`)];
  }

  render(width) {
    const entry = this.entry;
    this.title = typeof entry?.provider === 'string' && typeof entry?.model === 'string'
      ? `Side question · ${entry.provider}/${entry.model}`
      : 'Side question · /btw';
    return super.render(width);
  }
}
