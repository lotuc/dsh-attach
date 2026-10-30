import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionList, sessionLabel } from '../lib/client/session-list.js';

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

test('builds one flat row per visible session with metadata after the title', () => {
  const items = buildSessionList({
    sessions: [s1, s2, s3, s4],
    workspaceView,
    allSessions: [s1, s2, s3, s4, child],
    currentSessionId: 's2',
  });

  assert.equal(items.length, 3);
  assert.equal(items.some((item) => item.kind === 'group'), false);
  assert.deepEqual(items.map((item) => item.value), ['s2', 's1', 's3']);
  assert.equal(items[0].flat, true);
  assert.equal(items[0].current, true);
  assert.equal(items[0].label, 'Session s2 · Main');
  assert.equal(items[0].table, true);
  assert.equal(items[0].columns[0].text, '/work');
  assert.equal(items[0].path, '/work');
  assert.equal(items[0].columns[1].text, '1/1');
  assert.match(items[0].columns[2].text, /ago/);
  assert.equal(items.some((item) => item.value === 's4'), false);
});

test('uses cwd basename as a fallback workspace label', () => {
  const [item] = buildSessionList({
    sessions: [s3],
    workspaceView: { items: [], archivedSessionIds: [] },
  });
  assert.equal(item.label, 'Session s3 · other');
  assert.equal(item.columns[0].text, '/other');
});

test('sessionLabel falls back to a stable untitled label', () => {
  assert.equal(sessionLabel({ sessionId: '1234567890', title: '' }), '(untitled) 12345678');
});

test('pins sort before unpinned sessions and archived rows are opt-in', () => {
  const pinnedView = { ...workspaceView, pinnedSessionIds: ['s3'] };
  const items = buildSessionList({
    sessions: [s1, s2, s3, s4],
    workspaceView: pinnedView,
    allSessions: [s1, s2, s3, s4, child],
    currentSessionId: 's2',
    includeArchived: true,
  });

  assert.deepEqual(items.map((item) => item.value), ['s2', 's3', 's1', 's4']);
  assert.equal(items[1].pinned, true);
  assert.match(items[1].label, /^◆ /);
  assert.equal(items[3].archived, true);
  assert.match(items[3].label, /· archived$/);
});
