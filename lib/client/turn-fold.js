/**
 * Turn-level work-process fold, modeled on the DeepSeek Harness chat turn.
 *
 * The process rows (step groups, reasoning, tools) stay in document order and
 * are hidden while the fold is collapsed. Assistant replies are never part of
 * the fold, so the conversation keeps its answers visible.
 */
import { Container, truncateToWidth } from '@earendil-works/pi-tui';

import { formatClock, formatDuration } from './format.js';
import { liveActivityLabel } from './live-activity.js';
import { bold, green, red, yellow } from './theme.js';

/** Backward-compatible export used by callers/tests. */
export const formatTurnDuration = formatDuration;

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
    this.activity = 'thinking';
    this.activityDetail = '';
  }

  addTool() {
    this.toolCalls += 1;
    this.revision += 1;
  }

  addFailure() {
    this.failures += 1;
    this.revision += 1;
  }

  /** Update the live activity phrase shown while the turn is running. */
  setActivity(activity, detail = '') {
    const nextActivity = typeof activity === 'string' && activity !== '' ? activity : 'preparing';
    const nextDetail = typeof detail === 'string' ? detail : '';
    if (this.activity === nextActivity && this.activityDetail === nextDetail) return;
    this.activity = nextActivity;
    this.activityDetail = nextDetail;
    this.revision += 1;
  }

  get activityLabel() {
    return liveActivityLabel(this.activity, this.activityDetail);
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

  /** Force the cached header to re-render its live elapsed time. */
  tick() {
    if (this.running) this.revision += 1;
  }

  get title() {
    const start = formatClock(this.startedAt);
    if (this.running) {
      const elapsed = formatDuration(Date.now() - this.startedAt);
      const timing = [start === '' ? '' : `started ${start}`, elapsed].filter(Boolean).join(' · ');
      return `${this.activityLabel}${timing === '' ? '' : ` · ${timing}`}`;
    }
    const end = this.endedAt ?? Date.now();
    const duration = formatDuration(end - this.startedAt);
    const when = formatClock(end);
    const completed = when === '' ? '' : ` at ${when}`;
    if (this.failures > 0) {
      return `Failed${completed} · ${duration}${this.toolCalls === 0 ? '' : ` · ${pluralCount(this.toolCalls, 'tool call')}`}`;
    }
    if (this.toolCalls === 0) return `Thought for a while${completed}`;
    return `Completed${completed} · ${duration} · ${pluralCount(this.toolCalls, 'tool call')}`;
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
