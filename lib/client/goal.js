/** Normalize the goal projection wrapper and goal/change payload into one shape. */
import { oneLine } from './transcript.js';

export function normalizeGoal(value) {
  if (value === null || typeof value !== 'object') return null;
  if (value.goal !== null && typeof value.goal === 'object') return value.goal;
  return typeof value.phase === 'string' ? value : null;
}

/** Compact activity-line label, including the blocked reason when present. */
export function goalActivityLabel(goal, max = 64) {
  if (goal === null || typeof goal !== 'object' || typeof goal.phase !== 'string') return '';
  if (goal.phase === 'blocked') {
    const reason = goal.blockedReason?.message ?? goal.objective;
    return reason === undefined ? 'goal blocked' : `goal blocked · ${oneLine(reason, max)}`;
  }
  return `goal ${goal.phase}`;
}

/** Full status-panel goal line. */
export function goalStatus(goal) {
  if (goal === null || typeof goal !== 'object' || typeof goal.phase !== 'string') return '—';
  const objective = typeof goal.objective === 'string' ? goal.objective : '';
  const base = `${goal.phase}${objective === '' ? '' : ` · ${oneLine(objective, 60)}`}`;
  const reason = goal.blockedReason?.message;
  return goal.phase === 'blocked' && typeof reason === 'string' && reason.trim() !== ''
    ? `${base} · ${oneLine(reason, 80)}`
    : base;
}
