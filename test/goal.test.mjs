import assert from 'node:assert/strict';
import test from 'node:test';

import { goalActivityLabel, goalStatus, normalizeGoal } from '../lib/client/goal.js';

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
});

test('shows the blocked reason in the status line', () => {
  assert.equal(goalStatus(null), '—');
  assert.equal(goalStatus(goal('active')), 'active · Finish the task');
  assert.equal(
    goalStatus(goal('blocked', { blockedReason: { code: 'x', message: 'needs input' } })),
    'blocked · Finish the task · needs input',
  );
});
