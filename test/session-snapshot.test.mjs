import assert from 'node:assert/strict';
import test from 'node:test';

import { applySnapshotState } from '../lib/client/session-snapshot.js';

function makeState(overrides = {}) {
  return {
    title: 'old title',
    cwd: '/old',
    preset: 'old-preset',
    permission: 'read-only',
    provider: 'old-provider',
    model: 'old-model',
    contextWindow: 1_000,
    contextTokens: 100,
    tokens: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1 },
    todos: [{ id: 'old' }],
    goal: { phase: 'active', objective: 'old goal' },
    plan: { active: false, pending: false },
    ...overrides,
  };
}

test('applies the authoritative snapshot projection fields', () => {
  const state = makeState();
  const result = applySnapshotState(state, {
    header: { cwd: '/new' },
    projections: {
      values: {
        title: 'New title',
        agentPreset: 'reviewer',
        permissions: { currentValue: 'workspace-write' },
        modelSelection: { lastUsed: { provider: 'p', model: 'm' } },
        tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 20, outputTokens: 5 },
        contextPressure: { contextWindow: 2_000, pressureTokens: 150 },
        todos: [{ id: 'new' }],
        goal: { goal: { phase: 'active', objective: 'new goal' } },
        plan: { active: true, pending: true },
      },
    },
  });

  assert.deepEqual(result, { cwdChanged: true });
  assert.equal(state.title, 'New title');
  assert.equal(state.cwd, '/new');
  assert.equal(state.preset, 'reviewer');
  assert.equal(state.permission, 'workspace-write');
  assert.equal(state.provider, 'p');
  assert.equal(state.model, 'm');
  assert.deepEqual(state.tokens, { inputTokens: 120, outputTokens: 5, cacheReadTokens: 20 });
  assert.equal(state.contextTokens, 150);
  assert.equal(state.contextWindow, 2_000);
  assert.deepEqual(state.todos, [{ id: 'new' }]);
  assert.equal(state.goal.objective, 'new goal');
  assert.deepEqual(state.plan, { active: true, pending: true });
});

test('falls back to old values when the snapshot omits fields', () => {
  const state = makeState();
  const result = applySnapshotState(state, { projections: { values: {} } });

  assert.deepEqual(result, { cwdChanged: false });
  assert.equal(state.title, null, 'a snapshot without a title clears it');
  assert.equal(state.cwd, '/old');
  assert.equal(state.preset, 'old-preset');
  assert.equal(state.permission, 'read-only');
  assert.equal(state.provider, 'old-provider');
  assert.equal(state.model, 'old-model');
  assert.deepEqual(state.tokens, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1 });
  assert.equal(state.contextWindow, 1_000);
  assert.equal(state.contextTokens, 100);
  assert.deepEqual(state.todos, [{ id: 'old' }]);
  assert.equal(state.goal, null);
  assert.deepEqual(state.plan, { active: false, pending: false });
});

test('prefers header cwd over the workingDirectory projection', () => {
  const state = makeState();
  applySnapshotState(state, {
    header: { cwd: '/from-header' },
    projections: { values: { workingDirectory: '/from-values' } },
  });
  assert.equal(state.cwd, '/from-header');
});

test('uses the next model selection when lastUsed is absent', () => {
  const state = makeState();
  applySnapshotState(state, {
    projections: {
      values: {
        workingDirectory: '/next',
        modelSelection: { next: { provider: 'next-provider', model: 'next-model' } },
      },
    },
  });
  assert.equal(state.provider, 'next-provider');
  assert.equal(state.model, 'next-model');
});

test('ignores non-numeric pressure values and a non-object tokenUsage', () => {
  const state = makeState();
  applySnapshotState(state, {
    projections: {
      values: {
        tokenUsage: null,
        contextPressure: { contextWindow: 'n/a', pressureTokens: 'n/a' },
      },
    },
  });
  assert.deepEqual(state.tokens, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1 });
  assert.equal(state.contextWindow, 1_000);
  assert.equal(state.contextTokens, 100);
});
