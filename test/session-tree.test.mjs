import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionTree, sessionLabel } from '../lib/client/session-tree.js';

const now = Date.now();

function session(id, overrides = {}) {
  return {
    sessionId: id,
    title: `Session ${id}`,
    updatedAt: now,
    running: false,
    cwd: '/work',
    origin: 'session',
    ...overrides,
  };
}

const s1 = session('s1', { updatedAt: now - 10_000 });
const s2 = session('s2', { updatedAt: now - 5_000, running: true });
const s3 = session('s3', { cwd: '/other', updatedAt: now - 20_000 });
const s4 = session('s4', { cwd: '/archived', updatedAt: now - 30_000 });
const child = session('child', {
  origin: 'subagent',
  parentSessionId: 's2',
  running: true,
  cwd: '/work',
});

const workspaceView = {
  archivedSessionIds: ['s4'],
  items: [
    { workspaceId: 'w1', title: 'Main', path: '/work', sessionIds: ['s1', 's2'] },
  ],
};

test('builds a current workspace group and excludes archived sessions', () => {
  const items = buildSessionTree({
    sessions: [s1, s2, s3, s4],
    workspaceView,
    allSessions: [s1, s2, s3, s4, child],
    currentCwd: '/work/project',
    currentSessionId: 's2',
  });

  assert.equal(items[0].value, '__new__');
  const group = items.find((item) => item.kind === 'group' && item.groupKey === 'workspace:w1');
  assert.ok(group);
  assert.equal(group.current, true);
  assert.equal(group.label, 'Main');
  assert.match(group.meta, /agent/);
  const children = items.filter((item) => item.kind === 'session' && item.groupKey === group.groupKey);
  assert.deepEqual(children.map((item) => item.value), ['s2', 's1']);

  const sessions = items.filter((item) => item.kind === 'session');
  assert.equal(sessions.some((item) => item.value === 's4'), false);
  assert.equal(sessions[0].value, 's2');
  assert.equal(sessions[0].current, true);
  assert.match(sessions[0].description, /agent/);
  assert.equal(sessions[1].value, 's1');
});

test('adds a cwd fallback group for unregistered sessions', () => {
  const items = buildSessionTree({
    sessions: [s3],
    workspaceView: { items: [], archivedSessionIds: [] },
    currentCwd: '/other',
    currentSessionId: null,
  });
  const group = items.find((item) => item.kind === 'group');
  assert.ok(group);
  assert.match(group.groupKey, /^cwd:/);
  assert.equal(group.current, true);
  assert.match(group.label, /other/);
  assert.equal(items.find((item) => item.value === 's3').depth, 1);
});

test('sessionLabel falls back to a stable untitled label', () => {
  assert.equal(sessionLabel({ sessionId: '1234567890', title: '' }), '(untitled) 12345678');
});
