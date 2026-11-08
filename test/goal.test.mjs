import assert from 'node:assert/strict';
import test from 'node:test';

import { goalActivityLabel, goalHostLine, goalStatus, goalStatusLines, normalizeGoal, parseGoalCommand } from '../lib/client/goal.js';

const goal = (phase, overrides = {}) => ({
  id: 'g1',
  revision: 1,
  objective: 'Finish the task',
  phase,
  maxGoalRounds: 10,
  ...overrides,
});

test('normalizes projection wrappers and direct goal snapshots', () => {
  const inner = goal('active');
  assert.equal(normalizeGoal({ goal: inner, roundsStarted: 1 }), inner);
  assert.equal(normalizeGoal(inner), inner);
  assert.equal(normalizeGoal(null), null);
  assert.equal(normalizeGoal({}), null);
});

test('shows every goal phase in the activity label', () => {
  assert.equal(goalActivityLabel(goal('active')), 'goal active');
  assert.equal(goalActivityLabel(goal('paused')), 'goal paused');
  assert.equal(goalActivityLabel(goal('complete')), 'goal complete');
  assert.equal(goalActivityLabel(goal('blocked', { blockedReason: { code: 'x', message: 'needs input' } })), 'goal blocked · needs input');
  assert.equal(goalActivityLabel(goal('active'), 64, 'disarmed'), 'goal inactive');
  assert.equal(goalActivityLabel(goal('active'), 64, 'armed'), 'goal active');
});

test('shows the blocked reason in the status line', () => {
  assert.equal(goalStatus(null), '—');
  assert.equal(goalStatus(goal('active')), 'active · Finish the task');
  assert.equal(goalStatus(goal('active'), 'disarmed'), 'inactive · Finish the task');
  assert.equal(
    goalStatus(goal('blocked', { blockedReason: { code: 'x', message: 'needs input' } })),
    'blocked · Finish the task · needs input',
  );
});


test('parses local goal actions while preserving free-text objectives', () => {
  assert.deepEqual(parseGoalCommand(''), { kind: 'status' });
  assert.deepEqual(parseGoalCommand('status'), { kind: 'status' });
  assert.deepEqual(parseGoalCommand('PAUSE'), { kind: 'pause' });
  assert.deepEqual(parseGoalCommand('resume'), { kind: 'resume' });
  assert.deepEqual(parseGoalCommand('clear'), { kind: 'clear' });
  assert.deepEqual(parseGoalCommand('complete'), { kind: 'complete' });
  assert.deepEqual(parseGoalCommand('edit'), { kind: 'edit', objective: '' });
  assert.deepEqual(parseGoalCommand('edit  ship it '), { kind: 'edit', objective: 'ship it' });
  assert.deepEqual(parseGoalCommand('create ship it'), { kind: 'create', objective: 'ship it' });
  assert.deepEqual(parseGoalCommand('set ship it'), { kind: 'create', objective: 'ship it' });
  assert.deepEqual(parseGoalCommand('create'), {
    kind: 'usage',
    message: 'usage: /goal create <objective>',
  });
  assert.deepEqual(parseGoalCommand('complete the migration'), {
    kind: 'create',
    objective: 'complete the migration',
  });
  assert.deepEqual(parseGoalCommand('ship it'), { kind: 'create', objective: 'ship it' });
});

test('maps local goal actions to Host command lines', () => {
  assert.equal(goalHostLine({ kind: 'status' }), '/goal');
  assert.equal(goalHostLine({ kind: 'pause' }), '/goal pause');
  assert.equal(goalHostLine({ kind: 'resume' }), '/goal resume');
  assert.equal(goalHostLine({ kind: 'clear' }), '/goal clear');
  assert.equal(goalHostLine({ kind: 'edit', objective: 'fix it' }), '/goal edit fix it');
  assert.equal(goalHostLine({ kind: 'create', objective: 'ship it' }), '/goal ship it');
  assert.equal(goalHostLine({ kind: 'complete' }), null);
  assert.equal(goalHostLine({ kind: 'edit', objective: '' }), null);
});

test('renders goal status with rounds, activation and next actions', () => {
  assert.deepEqual(goalStatusLines(null), [
    'No goal is currently set.',
    '',
    'Create one with /goal <objective> or /goal create <objective>.',
  ]);
  const active = goalStatusLines(goal('active', { roundsStarted: 2 }), 'armed');
  assert.equal(active[0], 'phase      active');
  assert.equal(active[1], 'objective  Finish the task');
  assert.equal(active[2], 'rounds     2/10');
  assert.equal(active[3], 'activation armed');
  const commandLine = (lines) => lines.find((line) => line.startsWith('commands'));
  assert.match(commandLine(active), /^commands   \/goal pause · \/goal edit · \/goal complete · \/goal clear$/u);
  assert.match(goalStatusLines(goal('active', { roundsStarted: 2 }), 'disarmed')[0], /inactive/u);
  assert.match(commandLine(goalStatusLines(goal('paused'))), /^commands   \/goal resume/u);
  assert.match(commandLine(goalStatusLines(goal('complete'))), /^commands   \/goal <objective>/u);
  const blocked = goalStatusLines(goal('blocked', { blockedReason: { code: 'needs-input', message: 'needs input' } }));
  assert.ok(blocked.includes('blocker    needs-input: needs input'));
});
