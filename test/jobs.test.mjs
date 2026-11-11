import assert from 'node:assert/strict';
import test from 'node:test';

import { formatJobDuration, jobDetailsSections, jobItems, jobTitle, mergeJobEvent, runningJobCount, trimJobRoster } from '../lib/client/jobs.js';
import { JobOutputPanel } from '../lib/client/panels.js';

test('formats job durations compactly', () => {
  assert.equal(formatJobDuration(0), '0s');
  assert.equal(formatJobDuration(12_000), '12s');
  assert.equal(formatJobDuration(64_000), '1m 04s');
  assert.equal(formatJobDuration(3_900_000), '1h 05m');
});

test('builds stable output-panel titles', () => {
  assert.equal(jobTitle({ id: 'bash-a', kind: 'bash' }), 'Job bash-a · bash');
  assert.equal(jobTitle({}), 'Job job · job');
});

test('builds full job details without truncating the command', () => {
  const command = `npm test -- ${'very-long-argument '.repeat(10)}`;
  const sections = jobDetailsSections({
    id: 'bash-a',
    kind: 'bash',
    label: command,
    status: 'completed',
    owner: 's1',
    startedAt: 1_000,
    finishedAt: 6_000,
    detail: 'exit code: 0',
    output: { total: 2048, earliest: 12, lossy: true },
  }, 10_000);

  assert.deepEqual(sections.map((section) => section.label), ['Command', 'Job', 'Timing', 'Progress', 'Output']);
  assert.equal(sections[0].text, command);
  assert.match(sections[2].text, /^started: 1970-01-01T00:00:01\.000Z$/m);
  assert.match(sections[2].text, /^elapsed: 5s$/m);
  assert.match(sections[3].text, /exit code: 0/);
  assert.match(sections[4].text, /total: 2048 B/);
  assert.match(sections[4].text, /earliest offset: 12/);
  assert.match(sections[4].text, /dropped/);
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
  let details = 0;
  const panel = new JobOutputPanel('Job bash-a', {
    onKill: () => { killed += 1; },
    onClose: () => { closed += 1; },
    onDetails: () => { details += 1; },
  });
  panel.setText('line one\nline two');
  panel.setCommand('sleep 10', 'bash');
  panel.setFooter('bash · running · 12 B');
  const lines = panel.render(80);
  assert.ok(lines.some((line) => line.includes('sleep 10')));
  assert.ok(lines.some((line) => line.includes('line one')));
  assert.ok(lines.some((line) => line.includes('bash · running')));
  assert.ok(lines.some((line) => line.includes('enter/d full command')));
  panel.handleInput('\r');
  panel.handleInput('d');
  panel.handleInput('k');
  panel.handleInput('\x1b');
  assert.equal(details, 2);
  assert.equal(killed, 1);
  assert.equal(closed, 1);
});

test('job output header shows every command line', () => {
  const panel = new JobOutputPanel('Job bash-a', {});
  const command = ['export A=1', 'export B=2', 'export C=3', 'export D=4'].join('\n');
  panel.setCommand(command, 'bash');
  const text = panel.render(80).join('\n');
  for (const line of command.split('\n')) assert.match(text, new RegExp(line));
  assert.doesNotMatch(text, /more command line/);
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

test('keeps live jobs and only recent settled jobs', () => {
  const roster = new Map();
  for (let index = 0; index < 250; index += 1) {
    roster.set(`done-${index}`, {
      id: `done-${index}`,
      status: 'completed',
      startedAt: index,
      finishedAt: index,
    });
  }
  roster.set('live', { id: 'live', status: 'running', startedAt: 1 });
  const trimmed = trimJobRoster(roster);
  assert.equal(trimmed.has('live'), true);
  assert.equal(trimmed.size, 201);
  assert.equal(trimmed.has('done-249'), true);
  assert.equal(trimmed.has('done-0'), false);
});
