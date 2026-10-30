import assert from 'node:assert/strict';
import test from 'node:test';

import { mapSubagentRow, summarizeSubagents } from '../lib/host/subagents.js';

const subagent = (sessionId, parentSessionId, extra = {}) => ({
  sessionId,
  parentSessionId,
  origin: 'subagent',
  running: true,
  projections: { values: { title: `Title ${sessionId}` } },
  ...extra,
});

test('summarizeSubagents walks descendants and counts only subagents', () => {
  const items = [
    subagent('a', 'root'),
    subagent('b', 'a'),
    { sessionId: 'link', parentSessionId: 'a', origin: 'session', running: true },
    subagent('c', 'link'),
    subagent('d', null),
  ];

  assert.deepEqual(summarizeSubagents(items, 'root'), {
    total: 3,
    running: 3,
    active: [
      { id: 'a', parentSessionId: 'root', title: 'Title a' },
      { id: 'b', parentSessionId: 'a', title: 'Title b' },
      { id: 'c', parentSessionId: 'link', title: 'Title c' },
    ],
  });
});

test('summarizeSubagents caps the active window but keeps counting', () => {
  const items = Array.from({ length: 12 }, (_, index) => subagent(`c${index}`, 'root'));
  const summary = summarizeSubagents(items, 'root', { activeLimit: 2 });
  assert.equal(summary.total, 12);
  assert.equal(summary.running, 12);
  assert.equal(summary.active.length, 2);
});

test('summarizeSubagents ignores inactive rows and cycles', () => {
  const items = [
    subagent('a', 'root', { running: false }),
    subagent('b', 'a'),
    subagent('root', 'b'),
  ];
  assert.deepEqual(summarizeSubagents(items, 'root'), {
    total: 2,
    running: 1,
    active: [{ id: 'b', parentSessionId: 'a', title: 'Title b' }],
  });
});

test('mapSubagentRow normalizes fields and applies overrides', () => {
  assert.deepEqual(mapSubagentRow({ id: 7, parentId: 3, depth: 2, mode: 'one-shot', activity: 'running', label: 'Reviewer' }), {
    id: '7',
    parentId: '3',
    depth: 2,
    mode: 'one-shot',
    activity: 'running',
    label: 'Reviewer',
  });

  assert.deepEqual(mapSubagentRow({ id: 'c1', parentId: 'root', activity: 'inactive' }, {
    parentId: 'root',
    depth: 1,
    activity: 'running',
  }), {
    id: 'c1',
    parentId: 'root',
    depth: 1,
    mode: 'unknown',
    activity: 'running',
    label: null,
  });
});
