/**
 * Coordinates one turn/step's tool and reasoning rows.
 *
 * This keeps the step lifecycle and call-id bookkeeping out of the TUI class.
 * It owns no rendering or terminal state; the host view supplies callbacks for
 * adding/removing transcript rows and for the two expansion levels.
 */
import { ReasoningRow, StepGroupRow, ToolRow } from './transcript.js';

export class StepActivity {
  constructor({
    addRow,
    removeRow,
    requestRender = () => {},
    isGroupExpanded = () => false,
    isToolExpanded = () => false,
  }) {
    this.addRow = addRow;
    this.removeRow = removeRow;
    this.requestRender = requestRender;
    this.isGroupExpanded = isGroupExpanded;
    this.isToolExpanded = isToolExpanded;
    this.group = null;
    this.groupKey = null;
    this.toolRows = new Map();
    this.toolGroups = new Map();
  }

  #ensureGroup(turn, step) {
    const key = `${turn}:${step}`;
    if (this.group !== null && this.groupKey === key) return this.group;
    this.group?.finish();
    const group = new StepGroupRow(() => this.isGroupExpanded() || group.status === 'running');
    this.group = group;
    this.groupKey = key;
    this.addRow(group);
    return group;
  }

  onToolCall(callId, name, args, turn, step) {
    if (typeof callId !== 'string' || typeof name !== 'string') return null;
    const group = this.#ensureGroup(turn, step);
    const row = new ToolRow(name, args, () => this.isToolExpanded());
    group.addTool(name, row);
    this.toolRows.set(callId, row);
    this.toolGroups.set(callId, group);
    this.requestRender();
    return row;
  }

  onToolResult(callId, summary, isError) {
    const row = this.toolRows.get(callId);
    if (row !== undefined) {
      row.finish(summary, isError);
      const group = this.toolGroups.get(callId);
      if (group !== undefined) group.revision += 1;
      this.requestRender();
      return row;
    }
    const fallback = new ToolRow('tool', '', () => this.isToolExpanded());
    fallback.finish(summary, isError);
    if (this.group !== null) {
      this.group.addTool('tool', fallback);
      this.toolGroups.set(callId, this.group);
    } else {
      this.addRow(fallback);
    }
    this.toolRows.set(callId, fallback);
    this.requestRender();
    return fallback;
  }

  /** Add a reasoning row to the current step group, or standalone if none. */
  attachReasoning(row) {
    if (!(row instanceof ReasoningRow)) return null;
    if (this.group !== null) {
      this.group.addReasoning(row);
      this.requestRender();
      return this.group;
    }
    this.addRow(row);
    return null;
  }

  updateReasoning(row) {
    const group = this.#groupForReasoning(row);
    if (group === null) return;
    group.revision += 1;
    this.requestRender();
  }

  removeReasoning(row) {
    const group = this.#groupForReasoning(row);
    if (group === null) {
      this.removeRow(row);
      return;
    }
    group.remove(row);
    if (group.rows.length === 0 && group === this.group) {
      this.removeRow(group);
      this.group = null;
      this.groupKey = null;
    }
    this.requestRender();
  }

  #groupForReasoning(row) {
    if (this.group !== null && this.group.rows.includes(row)) return this.group;
    return null;
  }

  rowFor(callId) {
    return this.toolRows.get(callId);
  }

  /** Finish the current group but keep it available for late reasoning. */
  finish() {
    this.group?.finish();
    this.requestRender();
  }

  /** Start a new step, closing any previous group. */
  startStep() {
    this.group?.finish();
    this.group = null;
    this.groupKey = null;
  }

  trim(droppedSet) {
    if (this.group !== null && droppedSet.has(this.group)) {
      this.group = null;
      this.groupKey = null;
    }
    for (const [callId, row] of this.toolRows) {
      if (droppedSet.has(row)) this.toolRows.delete(callId);
    }
    for (const [callId, group] of this.toolGroups) {
      if (droppedSet.has(group)) {
        this.toolRows.delete(callId);
        this.toolGroups.delete(callId);
      }
    }
  }

  clear() {
    this.group = null;
    this.groupKey = null;
    this.toolRows.clear();
    this.toolGroups.clear();
  }
}
