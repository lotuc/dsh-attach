/**
 * Turn-level work-process fold, modeled on the DeepSeek Harness chat turn.
 *
 * The process rows (step groups, reasoning, tools) stay in document order and
 * are hidden while the fold is collapsed. Assistant replies are never part of
 * the fold, so the conversation keeps its answers visible.
 */
import { Container, truncateToWidth } from '@earendil-works/pi-tui';

import { bold, green, red, yellow } from './theme.js';

/** Compact duration for a completed turn. */
export function formatTurnDuration(milliseconds) {
  const ms = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  if (ms < 1_000) return '<1s';
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function pluralCount(count, singular) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/** Lifecycle summary for one turn's model work. */
export class TurnFoldRow {
  constructor({ turn = 0, startedAt = Date.now(), now = Date.now() } = {}) {
    this.turn = Number(turn) || 0;
    this.startedAt = Number.isFinite(startedAt) ? startedAt : now;
    this.endedAt = null;
    this.toolCalls = 0;
    this.failures = 0;
    this.running = true;
    this.collapsed = false;
    this.headerAdded = false;
    this.revision = 0;
    this.processRows = new Set();
  }

  addTool() {
    this.toolCalls += 1;
    this.revision += 1;
  }

  addFailure() {
    this.failures += 1;
    this.revision += 1;
  }

  finish({ endedAt = Date.now(), failed = false } = {}) {
    if (!this.running) return;
    this.running = false;
    this.endedAt = Number.isFinite(endedAt) ? endedAt : Date.now();
    if (failed) this.failures = Math.max(1, this.failures);
    this.revision += 1;
    this.setCollapsed(true);
  }

  setCollapsed(collapsed) {
    const next = collapsed === true;
    if (this.collapsed === next) return;
    this.collapsed = next;
    this.revision += 1;
    for (const row of this.processRows) row.hiddenByTurn = next;
  }

  toggle() {
    this.setCollapsed(!this.collapsed);
  }

  get title() {
    if (this.running) {
      return this.toolCalls === 0 ? 'Thinking' : `Working · ${pluralCount(this.toolCalls, 'tool call')}`;
    }
    const duration = formatTurnDuration((this.endedAt ?? this.startedAt) - this.startedAt);
    if (this.failures > 0) {
      return `Failed in ${duration}${this.toolCalls === 0 ? '' : ` · ${pluralCount(this.toolCalls, 'tool call')}`}`;
    }
    if (this.toolCalls === 0) return 'Thought for a while';
    return `Completed in ${duration} · ${pluralCount(this.toolCalls, 'tool call')}`;
  }

  render(width) {
    const chevron = this.collapsed ? '▸' : '▾';
    const dot = this.running ? yellow('◐') : this.failures > 0 ? red('✗') : green('✓');
    const title = this.title;
    const line = `${chevron} ${dot} ${bold(title)}`;
    return [truncateToWidth(line, width)];
  }
}

/** Container that omits turn-fold process rows while their fold is collapsed. */
export class TranscriptDocument extends Container {
  #isHidden;

  constructor(isHidden = () => false) {
    super();
    this.#isHidden = isHidden;
  }

  render(width) {
    const lines = [];
    for (const child of this.children) {
      if (this.#isHidden(child)) continue;
      for (const line of child.render(width)) lines.push(line);
    }
    return lines;
  }
}
