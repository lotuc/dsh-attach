/**
 * Pure projection for state-only Session events.
 *
 * Transcript, tool, queue, and job events stay in AttachApp because they need
 * UI side effects. These events only update visible session metadata, so they
 * can be tested without a TUI or Host.
 */
import { oneLine } from './transcript.js';
import { normalizeGoal } from './goal.js';

function note(text, tone) {
  return { handled: true, changed: false, note: { text, tone } };
}

export function projectSessionState(state, type, data) {
  switch (type) {
    case 'session/title':
      if (typeof data.title === 'string' && data.title.trim() !== '') state.title = data.title;
      return { handled: true, changed: true, herdr: true };
    case 'request/context':
      if (typeof data.provider === 'string') state.provider = data.provider;
      if (typeof data.model === 'string') state.model = data.model;
      if (Number.isFinite(Number(data.contextWindow))) state.contextWindow = Number(data.contextWindow);
      return { handled: true, changed: true };
    case 'model/selection': {
      const selection = data.selection ?? (typeof data.provider === 'string' && typeof data.model === 'string' ? data : null);
      if (selection !== null) {
        state.provider = selection.provider ?? state.provider;
        state.model = selection.model ?? state.model;
      }
      return { handled: true, changed: true };
    }
    case 'permission/preset':
      if (typeof data.preset === 'string') state.permission = data.preset;
      return { handled: true, changed: true };
    case 'sandbox/mode':
      if (typeof data.mode === 'string' && state.permission === null) state.permission = data.mode;
      return { handled: true, changed: false };
    case 'agent-preset/selected':
      if (typeof data.preset === 'string') state.preset = data.preset;
      return { handled: true, changed: false };
    case 'working-directory/change':
      if (typeof data.cwd === 'string') state.cwd = data.cwd;
      else if (typeof data.path === 'string') state.cwd = data.path;
      return { handled: true, changed: true, autocomplete: true };
    case 'todo/write': {
      const todos = Array.isArray(data.todos) ? data.todos : Array.isArray(data.items) ? data.items : null;
      if (todos !== null) state.todos = todos;
      return { handled: true, changed: true };
    }
    case 'goal/change':
      state.goalActivation = null;
      if (data.operation === 'clear') state.goal = null;
      else state.goal = normalizeGoal(data.goal);
      return { handled: true, changed: true };
    case 'plan/mode':
      state.plan = { active: data.active === true, pending: data.pending === true };
      return { handled: true, changed: true };
    case 'llm/retry':
      return note(`retrying: ${oneLine(data.reason ?? data.error?.message ?? 'model request failed', 100)}`, 'warn');
    case 'compaction/start':
      return note('compacting context…', 'dim');
    case 'compaction/end':
      return note('context compacted', 'dim');
    case 'compaction/summary':
      return note('context summary written', 'dim');
    case 'approval/policy':
      return { handled: true, changed: false };
    case 'approval/asked':
      return note(`approval requested: ${oneLine(data.toolName ?? 'tool', 60)}`, 'warn');
    case 'approval/decided':
      return note(`approval ${data.outcome === 'allowed-once' ? 'allowed once' : String(data.outcome ?? 'closed')}`, data.outcome === 'allowed-once' ? 'ok' : 'warn');
    default:
      return { handled: false, changed: false };
  }
}
