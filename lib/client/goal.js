/** Normalize the goal projection wrapper and goal/change payload into one shape. */
import { oneLine } from './transcript.js';

export function normalizeGoal(value) {
  if (value === null || typeof value !== 'object') return null;
  if (value.goal !== null && typeof value.goal === 'object') return value.goal;
  return typeof value.phase === 'string' ? value : null;
}

/** Compact activity-line label, including the blocked reason when present. */
export function goalActivityLabel(goal, max = 64, activation = null) {
  if (goal === null || typeof goal !== 'object' || typeof goal.phase !== 'string') return '';
  if (goal.phase === 'blocked') {
    const reason = goal.blockedReason?.message ?? goal.objective;
    return reason === undefined ? 'goal blocked' : `goal blocked · ${oneLine(reason, max)}`;
  }
  if (goal.phase === 'active' && activation === 'disarmed') return 'goal inactive';
  return `goal ${goal.phase}`;
}

/** Parse the TUI's `/goal` grammar while preserving Host-compatible free text. */
export function parseGoalCommand(rawInput) {
  const input = String(rawInput ?? '').trim();
  if (input === '') return { kind: 'status' };
  const control = input.toLowerCase();
  if (control === 'status' || control === 'show') return { kind: 'status' };
  if (control === 'pause') return { kind: 'pause' };
  if (control === 'resume') return { kind: 'resume' };
  if (control === 'clear') return { kind: 'clear' };
  if (control === 'complete') return { kind: 'complete' };
  if (control === 'edit') return { kind: 'edit', objective: '' };
  const edit = /^edit\s+([\s\S]*)$/iu.exec(input);
  if (edit !== null) return { kind: 'edit', objective: edit[1].trim() };
  if (control === 'create' || control === 'set') {
    return { kind: 'usage', message: 'usage: /goal create <objective>' };
  }
  const create = /^(?:create|set)\s+([\s\S]*)$/iu.exec(input);
  if (create !== null) return { kind: 'create', objective: create[1].trim() };
  // Everything else is an objective, matching the Host command grammar.
  return { kind: 'create', objective: input };
}

/** Translate one local goal action into its Host command line, when one exists. */
export function goalHostLine(command) {
  switch (command?.kind) {
    case 'status': return '/goal';
    case 'pause': return '/goal pause';
    case 'resume': return '/goal resume';
    case 'clear': return '/goal clear';
    case 'edit': return command.objective === '' ? null : `/goal edit ${command.objective}`;
    case 'create': return command.objective === '' ? null : `/goal ${command.objective}`;
    default: return null;
  }
}

function goalCommandHint(goal, activation) {
  if (goal.phase === 'complete') return '/goal <objective> · /goal clear';
  if (goal.phase === 'active' && activation !== 'disarmed') {
    return '/goal pause · /goal edit · /goal complete · /goal clear';
  }
  return '/goal resume · /goal edit · /goal complete · /goal clear';
}

/** Detailed lines for the `/goal` status panel. */
export function goalStatusLines(goal, activation = null) {
  if (goal === null || typeof goal !== 'object' || typeof goal.phase !== 'string') {
    return [
      'No goal is currently set.',
      '',
      'Create one with /goal <objective> or /goal create <objective>.',
    ];
  }
  const inactive = goal.phase === 'active' && activation === 'disarmed';
  const lines = [
    `phase      ${goal.phase}${inactive ? ' (inactive: continuation disarmed)' : ''}`,
    `objective  ${oneLine(typeof goal.objective === 'string' ? goal.objective : '', 200)}`,
  ];
  const rounds = Number(goal.roundsStarted);
  const cap = Number(goal.maxGoalRounds);
  if (Number.isFinite(cap)) {
    lines.push(`rounds     ${Number.isFinite(rounds) ? rounds : '—'}/${cap}`);
  }
  if (typeof activation === 'string' && activation !== '') lines.push(`activation ${activation}`);
  if (goal.phase === 'blocked') {
    const code = typeof goal.blockedReason?.code === 'string' ? goal.blockedReason.code : '';
    const message = typeof goal.blockedReason?.message === 'string' ? goal.blockedReason.message : '';
    const blocker = [code, message].filter((part) => part !== '').join(': ');
    if (blocker !== '') lines.push(`blocker    ${oneLine(blocker, 200)}`);
  }
  lines.push('', `commands   ${goalCommandHint(goal, activation)}`);
  lines.push('', 'Complete and clear ask for confirmation.');
  return lines;
}

/** Full status-panel goal line. */
export function goalStatus(goal, activation = null) {
  if (goal === null || typeof goal !== 'object' || typeof goal.phase !== 'string') return '—';
  const objective = typeof goal.objective === 'string' ? goal.objective : '';
  const phase = goal.phase === 'active' && activation === 'disarmed' ? 'inactive' : goal.phase;
  const base = `${phase}${objective === '' ? '' : ` · ${oneLine(objective, 60)}`}`;
  const reason = goal.blockedReason?.message;
  return goal.phase === 'blocked' && typeof reason === 'string' && reason.trim() !== ''
    ? `${base} · ${oneLine(reason, 80)}`
    : base;
}
