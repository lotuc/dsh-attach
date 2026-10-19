import assert from 'node:assert/strict';
import test from 'node:test';

import { HerdrReporter, herdrContext, herdrReportArgs } from '../lib/client/herdr.js';

const ENV = {
  HERDR_ENV: '1',
  HERDR_PANE_ID: 'w1:p1',
  HERDR_BIN_PATH: '/opt/homebrew/bin/herdr',
};

test('ignores environments outside a Herdr pane', () => {
  assert.equal(herdrContext({}), null);
  assert.equal(herdrContext({ HERDR_ENV: '1' }), null);
  assert.deepEqual(herdrContext(ENV), {
    pane: 'w1:p1',
    bin: '/opt/homebrew/bin/herdr',
    socket: null,
  });
});

test('builds report-agent arguments with a resume command', () => {
  const args = herdrReportArgs(herdrContext(ENV), 'blocked', {
    seq: 7,
    message: 'bash approval',
    sessionId: 'session-a',
    resume: ['dsh-attach', '-s', 'session-a'],
  });
  assert.deepEqual(args, [
    'pane',
    'report-agent',
    'w1:p1',
    '--source',
    'dsh-tui-attach',
    '--agent',
    'dsh',
    '--state',
    'blocked',
    '--seq',
    '7',
    '--message',
    'bash approval',
    '--agent-session-id',
    'session-a',
    '--',
    'dsh-attach',
    '-s',
    'session-a',
  ]);
});

test('reports state changes, refreshes resume per session and releases once', () => {
  const reports = [];
  const releases = [];
  const reporter = new HerdrReporter(ENV, {
    now: () => 100,
    spawn: (bin, args) => {
      reports.push({ bin, args });
      return { on() {}, unref() {}, kill() {} };
    },
    spawnSync: (bin, args) => {
      releases.push({ bin, args });
      return {};
    },
  });
  assert.equal(reporter.active, true);
  assert.equal(reporter.pane, 'w1:p1');
  assert.equal(reporter.report('working', { sessionId: 's1', resume: ['dsh-attach', '-s', 's1'] }), true);
  assert.equal(reporter.report('working', { sessionId: 's1', resume: ['dsh-attach', '-s', 's1'] }), false);
  assert.equal(reporter.report('blocked', { message: 'bash approval', sessionId: 's1' }), true);
  assert.equal(reporter.report('blocked', { message: 'bash approval', sessionId: 's1' }), false);
  assert.equal(reporter.report('idle', { sessionId: 's2', resume: ['dsh-attach', '-s', 's2'] }), true);

  assert.equal(reports.length, 3);
  assert.deepEqual(reports[0].args.slice(-6), ['--agent-session-id', 's1', '--', 'dsh-attach', '-s', 's1']);
  assert.ok(reports[1].args.includes('blocked'));
  assert.deepEqual(reports[2].args.slice(-6), ['--agent-session-id', 's2', '--', 'dsh-attach', '-s', 's2']);

  assert.equal(reporter.release(), true);
  assert.equal(reporter.release(), false);
  assert.equal(releases.length, 1);
  assert.ok(releases[0].args.includes('release-agent'));
  assert.equal(reporter.report('idle', { sessionId: 's3' }), false);
});
