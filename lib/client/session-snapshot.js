/**
 * Pure projection of the authoritative Session snapshot onto visible state.
 *
 * Snapshot handling also resets the inbox, replays history and scrolls the
 * transcript; those UI side effects stay in AttachApp. This module only owns
 * the field-by-field fallback rules so they can be tested without a TUI.
 */
import { normalizeGoal } from './goal.js';

/**
 * Apply snapshot projections to `state` in place.
 *
 * @param {object} state - AttachApp session state
 * @param {object} frame - `snapshot` frame
 * @returns {{cwdChanged: boolean}}
 */
export function applySnapshotState(state, frame) {
  const values = frame?.projections?.values ?? {};
  const previousCwd = state.cwd;

  state.title = typeof values.title === 'string' ? values.title : null;
  state.cwd = typeof frame.header?.cwd === 'string'
    ? frame.header.cwd
    : typeof values.workingDirectory === 'string'
      ? values.workingDirectory
      : state.cwd;
  state.preset = typeof values.agentPreset === 'string' ? values.agentPreset : state.preset;
  state.permission = values.permissions?.currentValue ?? state.permission;

  const selection = values.modelSelection?.lastUsed ?? values.modelSelection?.next ?? null;
  if (selection !== null) {
    state.provider = selection.provider ?? state.provider;
    state.model = selection.model ?? state.model;
  }

  if (values.tokenUsage !== null && typeof values.tokenUsage === 'object') {
    state.tokens = {
      inputTokens: Number(values.tokenUsage.uncachedInputTokens ?? 0) + Number(values.tokenUsage.cacheReadTokens ?? 0),
      outputTokens: Number(values.tokenUsage.outputTokens ?? 0),
      cacheReadTokens: Number(values.tokenUsage.cacheReadTokens ?? 0),
    };
    state.contextTokens = state.tokens.inputTokens;
  }

  if (values.contextPressure !== null && typeof values.contextPressure === 'object') {
    if (Number.isFinite(Number(values.contextPressure.contextWindow))) {
      state.contextWindow = Number(values.contextPressure.contextWindow);
    }
    if (Number.isFinite(Number(values.contextPressure.pressureTokens))) {
      state.contextTokens = Number(values.contextPressure.pressureTokens);
    }
  }

  if (Array.isArray(values.todos)) state.todos = values.todos;
  state.goal = normalizeGoal(values.goal);
  state.goalActivation = null;
  if (values.plan !== null && typeof values.plan === 'object') {
    state.plan = { active: values.plan.active === true, pending: values.plan.pending === true };
  }

  return { cwdChanged: state.cwd !== previousCwd };
}
