import assert from 'node:assert/strict';
import test from 'node:test';

import { AttachServer } from '../lib/host/server.js';

function serverWithJobs() {
  const view = {
    id: 'bash-a',
    kind: 'bash',
    label: 'build',
    status: 'running',
    startedAt: 100,
    output: { total: 3, earliest: 0 },
  };
  const calls = [];
  const jobs = {
    list(caller) {
      calls.push(['list', caller]);
      return [view];
    },
    get(id, caller) {
      calls.push(['get', id, caller]);
      if (id !== 'bash-a') throw new Error('job not found');
      return view;
    },
    readAt(id, from, caller) {
      calls.push(['readAt', id, from, caller]);
      return { chunks: [{ at: from, text: 'ok' }], next: from + 2, lossy: false };
    },
    kill(id, caller, reason) {
      calls.push(['kill', id, caller, reason]);
      return 'requested';
    },
  };
  const ctx = {
    sessionController: {},
    get(name) {
      return name === 'jobs' ? jobs : undefined;
    },
  };
  const server = new AttachServer(ctx, {
    enabled: true,
    socketPath: '',
    approvals: 'tui',
    questions: 'tui',
    activeWindowMinutes: 10,
    approvalGraceSeconds: 120,
    questionGraceSeconds: 300,
  });
  return { server, calls, view };
}

test('bridges job list, output and kill through the attach server', () => {
  const { server, calls, view } = serverWithJobs();
  assert.ok(server.hostInfo.capabilities.includes('jobs'));
  assert.deepEqual(server.listJobs('s1'), { jobs: [view] });
  assert.deepEqual(server.readJob('s1', 'bash-a', 0), {
    chunks: [{ at: 0, text: 'ok' }],
    next: 2,
    lossy: false,
    job: view,
  });
  assert.deepEqual(server.killJob('s1', 'bash-a'), { outcome: 'requested', job: view });
  assert.deepEqual(calls, [
    ['list', 's1'],
    ['readAt', 'bash-a', 0, 's1'],
    ['get', 'bash-a', 's1'],
    ['kill', 'bash-a', 's1', 'cancelled by the user'],
    ['get', 'bash-a', 's1'],
  ]);
});

test('reports unavailable jobs and rejects invalid read offsets', () => {
  const ctx = { sessionController: {}, get() { return undefined; } };
  const server = new AttachServer(ctx, {
    enabled: true,
    socketPath: '',
    approvals: 'tui',
    questions: 'tui',
    activeWindowMinutes: 10,
    approvalGraceSeconds: 120,
    questionGraceSeconds: 300,
  });
  assert.throws(() => server.listJobs('s1'), (error) => error.code === 'job/unavailable');

  const fixture = serverWithJobs();
  assert.throws(() => fixture.server.readJob('s1', 'bash-a', -1), (error) => error.code === 'attach/bad-request');
  assert.throws(() => fixture.server.readJob('s1', 'missing', 0), (error) => error.code === 'job/not-found');
});
