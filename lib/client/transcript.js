/**
 * Transcript rows for the attach TUI.
 *
 * The Host sends raw Session events; these components turn the small set of
 * user-visible ones into terminal rows. Rendering is intentionally forgiving:
 * unknown events are ignored rather than dumped into the conversation.
 */
import { Markdown, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import {
  accent,
  bold,
  cyan,
  faint,
  gray,
  green,
  italic,
  markdownTheme,
  orange,
  purple,
  red,
  yellow,
} from './theme.js';

/**
 * Strip terminal control sequences from untrusted text (model output, tool
 * output, questions, titles). Newlines and tabs survive; everything that could
 * drive the terminal (OSC, CSI, C0/C1) does not.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeText(value) {
  return String(value ?? '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\x1b[@-_]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
}

/** Flatten text/image content blocks. */
export function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
  }
  return parts.join('');
}

/** Split one assistant message into rendered text and reasoning. */
export function partsOfMessage(message) {
  const text = [];
  const reasoning = [];
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (block.type === 'reasoning' && typeof block.text === 'string') reasoning.push(block.text);
    else if (block.type === 'image') text.push('[image]');
  }
  return { text: text.join(''), reasoning: reasoning.join('') };
}

export function oneLine(text, max = 160) {
  const flat = sanitizeText(text).replace(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function firstLine(text) {
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() !== '') return line.trim();
  }
  return '';
}

const SKIP_ARG_KEYS = new Set(['description', 'timeoutMs', 'run_in_background', 'signal']);

function toolPreview(args) {
  if (typeof args !== 'string' || args.trim() === '') return '';
  try {
    const parsed = JSON.parse(args);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of ['command', 'path', 'file_path', 'query', 'url', 'pattern', 'objective']) {
        if (typeof parsed[key] === 'string' && parsed[key].trim() !== '') return oneLine(parsed[key], 220);
      }
      const pairs = [];
      for (const [key, value] of Object.entries(parsed)) {
        if (SKIP_ARG_KEYS.has(key)) continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          pairs.push(`${key}=${String(value)}`);
        }
        if (pairs.length >= 3) break;
      }
      if (pairs.length > 0) return oneLine(pairs.join(' '), 220);
    }
  } catch {
    // Not JSON; show the raw argument string.
  }
  return oneLine(args, 220);
}

function prefixed(lines, prefix, cont = prefix) {
  return lines.map((line, index) => `${index === 0 ? prefix : cont}${line}`);
}

function wrap(text, width) {
  if (width <= 0) return [''];
  return wrapTextWithAnsi(text, width);
}

/** User message: accent chevron, bold body. */
export class UserRow {
  constructor(text, sub) {
    this.text = sanitizeText(text);
    this.sub = sub === null || sub === undefined ? null : sanitizeText(sub);
  }

  render(width) {
    const prefix = `${accent('›')} `;
    const pad = '  ';
    const bodyWidth = Math.max(1, width - 2);
    const lines = wrap(bold(this.text), bodyWidth);
    const out = prefixed(lines, prefix, pad);
    if (this.sub !== null) out.push(`${pad}${faint(italic(this.sub))}`);
    return out.map((line) => truncateToWidth(line, width));
  }
}

const MAX_LIVE_MARKDOWN_CHARS = 40_000;

/** Assistant message, rendered as Markdown. */
export class AssistantRow {
  constructor(text, options = {}) {
    this.text = sanitizeText(text);
    this.markdown = new Markdown(this.text, 1, 0, markdownTheme);
    this.final = options.final === true;
    this.streaming = options.streaming === true;
  }

  setText(text) {
    const next = sanitizeText(text);
    if (next === this.text) return;
    this.text = next;
    this.markdown.setText(next);
  }

  /** Finish a live stream and render the complete Markdown body once. */
  finalize() {
    if (!this.streaming) return;
    this.streaming = false;
    this.markdown.setText(this.text);
  }

  render(width) {
    // A very long live answer can make full Markdown reflow dominate every
    // streaming tick. While streaming, show the tail as plain wrapped text;
    // finalize renders the complete Markdown once.
    if (this.streaming && this.text.length > MAX_LIVE_MARKDOWN_CHARS) {
      const tail = this.text.slice(-MAX_LIVE_MARKDOWN_CHARS);
      const lines = wrap(tail, Math.max(1, width - 2));
      return [
        truncateToWidth(faint('… long streaming output; showing recent text'), width),
        ...prefixed(lines, '  ').map((line) => truncateToWidth(line, width)),
      ];
    }
    return this.markdown.render(width);
  }
}

/** Reasoning / thinking: one dim line collapsed, full italic block expanded. */
export class ReasoningRow {
  constructor(text, isExpanded = () => false) {
    this.text = sanitizeText(text);
    this.isExpanded = isExpanded;
  }

  setText(text) {
    this.text = sanitizeText(text);
  }

  render(width) {
    if (this.text.trim() === '') return [];
    if (!this.isExpanded()) {
      const preview = firstLine(this.text);
      const count = `${this.text.length}`;
      const line = `${purple('✻')} ${italic(faint(preview))} ${faint(`· ${count} chars`)}`;
      return [truncateToWidth(line, width)];
    }
    const body = wrap(italic(gray(this.text)), Math.max(1, width - 2));
    return prefixed(body, '  ').map((line) => truncateToWidth(line, width));
  }
}

/** Tool names that represent shell commands and belong in a step group. */
export function isCommandTool(name) {
  return name === 'bash' || name === 'shell' || name === 'exec' || name === 'exec_command' || name === 'run_command';
}

export function isEditTool(name) {
  return ['edit', 'write', 'apply_patch', 'patch', 'replace', 'create_file', 'delete_file', 'notebook_edit'].includes(name);
}

export function isReadTool(name) {
  return ['read', 'read_file', 'grep', 'glob', 'search', 'list', 'view', 'find', 'ls', 'cat'].includes(name);
}

function groupNoun(tools) {
  const command = tools.some(isCommandTool);
  const edit = tools.some(isEditTool);
  const read = tools.some(isReadTool);
  if (command && edit && read) return 'commands, edited files and read files';
  if (command && edit) return 'commands and edited files';
  if (command && read) return 'commands and read files';
  if (command) return 'commands';
  if (edit && read) return 'edited files and read files';
  if (edit) return 'edited files';
  if (read) return 'read files';
  return 'tools';
}

/** One tool invocation and its result. */
export class ToolRow {
  constructor(name, args, isExpanded = () => false) {
    this.name = sanitizeText(name);
    this.args = sanitizeText(typeof args === 'string' ? args : args === undefined || args === null ? '' : JSON.stringify(args));
    this.summary = '';
    this.status = 'running';
    this.isExpanded = isExpanded;
    this.previewText = toolPreview(this.args);
  }

  finish(summary, isError) {
    this.summary = sanitizeText(summary);
    this.status = isError ? 'error' : 'done';
  }

  get preview() {
    return this.previewText;
  }

  render(width) {
    const preview = this.preview;
    const dot = this.status === 'running' ? yellow('◐') : this.status === 'error' ? red('✗') : green('✓');
    const name = bold(this.status === 'error' ? red(this.name) : this.name);
    const state = this.status === 'running' ? '' : faint(this.status === 'error' ? ' · error' : ' · done');
    const head = `${dot} ${name}${preview === '' ? '' : ` ${faint(preview)}`}${state}`;
    const lines = [truncateToWidth(head, width)];
    const expanded = this.isExpanded();

    if (expanded) {
      if (this.args.trim() !== '') {
        const argsLines = wrap(faint(this.args), Math.max(1, width - 4)).slice(0, 20);
        lines.push(...prefixed(argsLines, '    '));
      }
      if (this.summary.trim() !== '') {
        const summaryLines = wrap(this.summary, Math.max(1, width - 4)).slice(0, 40);
        lines.push(...prefixed(summaryLines, '  ⎿ ').map((line) => truncateToWidth(line, width)));
      }
    } else if (this.summary.trim() !== '') {
      const previewLine = firstLine(this.summary);
      const extra = this.summary.split('\n').length > 1 ? ' …' : '';
      lines.push(truncateToWidth(`  ⎿ ${faint(previewLine)}${faint(extra)}`, width));
    }
    return lines;
  }
}

/**
 * One step's activity: thinking and tool calls. The group is collapsed by
 * default after the step finishes; the active group opens automatically.
 */
export class StepGroupRow {
  constructor(isExpanded = () => false) {
    this.rows = [];
    this.toolNames = [];
    this.isExpanded = isExpanded;
    this.running = true;
    this.revision = 0;
  }

  addTool(name, row) {
    this.toolNames.push(name);
    this.rows.push(row);
    this.revision += 1;
  }

  addReasoning(row) {
    this.rows.push(row);
    this.revision += 1;
  }

  remove(row) {
    const index = this.rows.indexOf(row);
    if (index < 0) return;
    this.rows.splice(index, 1);
    this.revision += 1;
  }

  finish() {
    if (!this.running) return;
    this.running = false;
    this.revision += 1;
  }

  get status() {
    if (this.running || this.rows.some((row) => row.status === 'running')) return 'running';
    if (this.rows.some((row) => row.status === 'error')) return 'error';
    return 'done';
  }

  get title() {
    const status = this.status;
    if (status === 'running') return this.toolNames.length === 0 ? 'Thinking' : `Running ${groupNoun(this.toolNames)}`;
    if (status === 'done' && this.toolNames.length === 0) return 'Thought';
    return `Ran ${groupNoun(this.toolNames)}`;
  }

  render(width) {
    const status = this.status;
    const running = this.rows.filter((row) => row.status === 'running');
    const failed = this.rows.filter((row) => row.status === 'error').length;
    const expanded = this.isExpanded();
    const chevron = expanded ? '▾' : '▸';
    const dot = status === 'running' ? yellow('◐') : status === 'error' ? red('✗') : green('✓');
    let detail = '';
    if (status === 'running') {
      const active = running[0] ?? this.rows.at(-1);
      const preview = active?.preview || active?.name || (active === undefined ? '' : oneLine(active.text ?? '', 48));
      if (preview !== '') detail = ` · ${oneLine(preview, 48)}`;
    } else if (failed > 0) {
      detail = ` · ${failed} failed`;
    }
    const head = `${chevron} ${dot} ${bold(this.title)}${detail === '' ? '' : faint(detail)}`;
    const lines = [truncateToWidth(head, width)];
    if (!expanded) return lines;
    for (const row of this.rows) {
      if (row instanceof ReasoningRow && !row.isExpanded()) {
        const preview = oneLine(row.text, Math.max(10, width - 12));
        if (preview !== '') lines.push(truncateToWidth(`  ✻ ${bold('Think')} ${faint(`· ${preview}`)}`, width));
        continue;
      }
      const child = row.render(Math.max(1, width - 2));
      lines.push(...prefixed(child, '  ').map((line) => truncateToWidth(line, width)));
    }
    return lines;
  }
}

/** Dim one-off notice (retry, compaction, approval outcome, …). */
export class NoteRow {
  constructor(text, tone = 'dim') {
    this.text = sanitizeText(text);
    this.tone = tone;
  }

  render(width) {
    if (this.text.trim() === '') return [];
    const paint = this.tone === 'error' ? red : this.tone === 'warn' ? yellow : this.tone === 'ok' ? green : faint;
    const lines = wrap(paint(this.text), Math.max(1, width - 2));
    return prefixed(lines, '  ').map((line) => truncateToWidth(line, width));
  }
}

/** Blank spacer between logical groups. */
export class BlankRow {
  render() {
    return [''];
  }
}

/**
 * Cache one transcript row's rendered lines. Rows are immutable while the
 * conversation sits still, so an input keypress must not re-wrap every old
 * message. If a mutable field (text, summary, expansion, …) changes, the row
 * renders again; width changes invalidate the cache too.
 */
export class CachedRow {
  constructor(row) {
    this.row = row;
    this.cachedWidth = null;
    this.cachedLines = null;
    this.cachedExpanded = undefined;
    this.cachedText = undefined;
    this.cachedSub = undefined;
    this.cachedSummary = undefined;
    this.cachedStatus = undefined;
    this.cachedName = undefined;
    this.cachedArgs = undefined;
    this.cachedTone = undefined;
    this.cachedStreaming = undefined;
    this.cachedRevision = undefined;
  }

  invalidate() {
    this.cachedLines = null;
    this.row.invalidate?.();
  }

  render(width) {
    const row = this.row;
    const expanded = typeof row.isExpanded === 'function' ? row.isExpanded() : undefined;
    if (
      this.cachedLines !== null &&
      this.cachedWidth === width &&
      this.cachedExpanded === expanded &&
      this.cachedText === row.text &&
      this.cachedSub === row.sub &&
      this.cachedSummary === row.summary &&
      this.cachedStatus === row.status &&
      this.cachedName === row.name &&
      this.cachedArgs === row.args &&
      this.cachedTone === row.tone &&
      this.cachedStreaming === row.streaming &&
      this.cachedRevision === row.revision
    ) {
      return this.cachedLines;
    }
    const lines = row.render(width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    this.cachedExpanded = expanded;
    this.cachedText = row.text;
    this.cachedSub = row.sub;
    this.cachedSummary = row.summary;
    this.cachedStatus = row.status;
    this.cachedName = row.name;
    this.cachedArgs = row.args;
    this.cachedTone = row.tone;
    this.cachedStreaming = row.streaming;
    this.cachedRevision = row.revision;
    return lines;
  }
}

/** One-line status bar with left/right columns. */
export class StateLine {
  constructor(renderFn) {
    this.renderFn = renderFn;
  }

  render(width) {
    return [truncateToWidth(this.renderFn(width), width)];
  }
}

export const rowColors = { accent, cyan, orange, red, yellow, green };
