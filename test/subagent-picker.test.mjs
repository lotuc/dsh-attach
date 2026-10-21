import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSubagentPicker } from '../lib/client/subagent-picker.js';

const session = (id, overrides = {}) => ({
  sessionId: id,
  title: `Session ${id}`,
  updatedAt: 100,
  running: false,
  origin: 'session',
  ...overrides,
});

test('resolves the root and orders direct and nested subagents', () => {
  const root = session('root');
  const idle = session('idle', { origin: 'subagent', parentSessionId: 'root', updatedAt: 300 });
  const running = session('running', { origin: 'subagent', parentSessionId: 'root', running: true, updatedAt: 100 });
  const nested = session('nested', { origin: 'subagent', parentSessionId: 'running', updatedAt: 200 });
  const picker = buildSubagentPicker({
    sessions: [root, idle, running, nested],
    currentSessionId: 'nested',
    rootSessionId: 'nested',
  });

  assert.equal(picker.rootId, 'root');
  assert.equal(picker.rootLabel, 'Session root');
  assert.equal(picker.running, 1);
  assert.deepEqual(picker.items.map((item) => item.value), ['running', 'nested', 'idle']);
  assert.equal(picker.items[0].description.startsWith('direct'), true);
  assert.equal(picker.items[1].description.startsWith('nested'), true);
  assert.match(picker.items[1].label, /current/);
  assert.equal(picker.items[1].parentSessionId, 'running');
});

test('returns an empty picker when the root has no children', () => {
  const picker = buildSubagentPicker({
    sessions: [session('root'), session('plain')],
    currentSessionId: 'root',
    rootSessionId: 'root',
  });
  assert.deepEqual(picker.items, []);
  assert.equal(picker.rootId, 'root');
});

test('does not loop on malformed parent cycles', () => {
  const first = session('first', { origin: 'subagent', parentSessionId: 'second' });
  const second = session('second', { origin: 'subagent', parentSessionId: 'first' });
  const picker = buildSubagentPicker({
    sessions: [first, second],
    currentSessionId: 'first',
    rootSessionId: 'first',
  });
  assert.equal(picker.rootId, 'first');
  assert.deepEqual(picker.items.map((item) => item.value), ['second']);
});
