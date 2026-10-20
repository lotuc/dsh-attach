import assert from 'node:assert/strict';
import test from 'node:test';

import { formatJobDuration, jobItems, mergeJobEvent, runningJobCount } from '../lib/client/jobs.js';
import { JobOutputPanel } from '../lib/client/panels.js';

test('formats job durations compactly', () => {
  assert.equal(formatJobDuration(0), '0s');
  assert.equal(formatJobDuration(12_000), '12s');
  assert.equal(formatJobDuration(64_000), '1m 04s');
  assert.equal(formatJobDuration(3_900_000), '1h 05m');
});

test('orders live jobs first and keeps ids searchable', () => {
  const now = 10_000;
  const items = jobItems([
    { id: 'bash-finished', kind: 'bash', label: 'done', status: 'completed', startedAt: 1_000, finishedAt: 8_000 },
    { id: 'bash-running', kind: 'bash', label: 'long run', status: 'running', startedAt: 6_000, progress: 'halfway' },
  ], now);
  assert.deepEqual(items.map((item) => item.value), ['bash-running', 'bash-finished']);
  assert.equal(items[0].meta, 'running 4s');
  assert.match(items[0].description, /bash-running.*halfway/);
  assert.match(items[1].description, /bash-finished/);
});

test('job output panel renders text and routes kill/scroll keys', () => {
  let killed = 0;
  let closed = 0;
  const panel = new JobOutputPanel('Job bash-a', {
    onKill: () => { killed += 1; },
    onClose: () => { closed += 1; },
  });
  panel.setText('line one\nline two');
  panel.setFooter('bash · running · 12 B');
  const lines = panel.render(80);
  assert.ok(lines.some((line) => line.includes('line one')));
  assert.ok(lines.some((line) => line.includes('bash · running')));
  panel.handleInput('k');
  panel.handleInput('\x1b');
  assert.equal(killed, 1);
  assert.equal(closed, 1);
});

test('folds registration and settlement into a roster', () => {
  let roster = mergeJobEvent(new Map(), 'job/registered', {
    jobId: 'bash-a', kind: 'bash', label: 'build', owner: 's1', startedAt: 100,
  });
  assert.equal(runningJobCount([...roster.values()]), 1);
  roster = mergeJobEvent(roster, 'job/settled', {
    jobId: 'bash-a', kind: 'bash', label: 'build', owner: 's1', startedAt: 100, finishedAt: 200, status: 'completed', detail: 'exit code: 0',
  });
  assert.equal(runningJobCount([...roster.values()]), 0);
  assert.equal(roster.get('bash-a').detail, 'exit code: 0');
});
