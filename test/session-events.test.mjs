import assert from 'node:assert/strict';
import test from 'node:test';

import { projectSessionState } from '../lib/client/session-events.js';

function state(overrides = {}) {
  return {
    title: null,
    provider: null,
    model: null,
    contextWindow: null,
    permission: null,
    preset: null,
    cwd: '/old',
    todos: [],
    goal: null,
    plan: null,
    ...overrides,
  };
}

test('projects metadata events into state', () => {
  const value = state({ permission: 'workspace' });
  assert.equal(projectSessionState(value, 'session/title', { title: 'Title' }).herdr, true);
  assert.equal(value.title, 'Title');

  projectSessionState(value, 'request/context', { provider: 'p', model: 'm', contextWindow: 1000 });
  assert.deepEqual([value.provider, value.model, value.contextWindow], ['p', 'm', 1000]);

  projectSessionState(value, 'working-directory/change', { cwd: '/new' });
  assert.equal(value.cwd, '/new');
  assert.equal(projectSessionState(value, 'working-directory/change', { cwd: '/new' }).autocomplete, true);

  projectSessionState(value, 'todo/write', { todos: [{ content: 'x' }] });
  assert.equal(value.todos.length, 1);

  projectSessionState(value, 'goal/change', { goal: { objective: 'done' } });
  assert.equal(value.goal.objective, 'done');
  projectSessionState(value, 'goal/change', { operation: 'clear' });
  assert.equal(value.goal, null);

  projectSessionState(value, 'plan/mode', { active: true, pending: false });
  assert.deepEqual(value.plan, { active: true, pending: false });

  projectSessionState(value, 'agent-preset/selected', { preset: 'fast' });
  assert.equal(value.preset, 'fast');
});

test('keeps permission precedence and projects selection', () => {
  const value = state();
  projectSessionState(value, 'sandbox/mode', { mode: 'read-only' });
  assert.equal(value.permission, 'read-only');
  projectSessionState(value, 'permission/preset', { preset: 'workspace' });
  assert.equal(value.permission, 'workspace');
  projectSessionState(value, 'sandbox/mode', { mode: 'read-only' });
  assert.equal(value.permission, 'workspace');

  projectSessionState(value, 'model/selection', { selection: { provider: 'p', model: 'm' } });
  assert.deepEqual([value.provider, value.model], ['p', 'm']);
  projectSessionState(value, 'model/selection', { provider: 'q', model: 'n' });
  assert.deepEqual([value.provider, value.model], ['q', 'n']);
});

test('returns notes for transient events and ignores unknown types', () => {
  const value = state();
  const retry = projectSessionState(value, 'llm/retry', { reason: 'rate limit' });
  assert.equal(retry.note.tone, 'warn');
  assert.match(retry.note.text, /rate limit/);
  assert.equal(projectSessionState(value, 'compaction/start', {}).note.text, 'compacting context…');
  assert.equal(projectSessionState(value, 'approval/decided', { outcome: 'allowed-once' }).note.tone, 'ok');
  assert.equal(projectSessionState(value, 'approval/policy', {}).handled, true);
  assert.equal(projectSessionState(value, 'unknown/event', {}).handled, false);
});
