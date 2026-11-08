import assert from 'node:assert/strict';
import test from 'node:test';

import { HerdrReporter, herdrContext, herdrEnvironment, herdrReportArgs, herdrReportMetadataArgs } from '../lib/client/herdr.js';

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

test('captures only Herdr facts from a managed pane', () => {
  assert.deepEqual(herdrEnvironment({
    ...ENV,
    HERDR_SOCKET_PATH: '/tmp/herdr.sock',
    HERDR_WORKSPACE_ID: 'w1',
    PATH: '/usr/bin',
  }), {
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'w1:p1',
    HERDR_BIN_PATH: '/opt/homebrew/bin/herdr',
    HERDR_SOCKET_PATH: '/tmp/herdr.sock',
    HERDR_WORKSPACE_ID: 'w1',
  });
  assert.deepEqual(herdrEnvironment({ HERDR_ENV: '0', HERDR_PANE_ID: 'p' }), {});
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
    'dsh-attach',
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

test('builds pane metadata arguments for the session title', () => {
  const args = herdrReportMetadataArgs(herdrContext(ENV), {
    title: 'Fix the tests',
    displayAgent: 'Fix the tests',
  });
  assert.deepEqual(args, [
    'pane',
    'report-metadata',
    'w1:p1',
    '--source',
    'dsh-attach',
    '--agent',
    'dsh',
    '--title',
    'Fix the tests',
    '--display-agent',
    'Fix the tests',
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

  assert.equal(reporter.reportTitle('  Fix\n the tests  '), true);
  assert.equal(reporter.reportTitle('Fix the tests'), false);
  assert.equal(reports.length, 4);
  assert.ok(reports[3].args.includes('--title'));
  assert.ok(reports[3].args.includes('Fix the tests'));
  assert.ok(reports[3].args.includes('--display-agent'));

  assert.equal(reporter.release(), true);
  assert.equal(reporter.release(), false);
  assert.equal(releases.length, 2);
  assert.ok(releases[0].args.includes('--clear-title'));
  assert.ok(releases[0].args.includes('--clear-display-agent'));
  assert.ok(releases[1].args.includes('release-agent'));
  assert.equal(reporter.report('idle', { sessionId: 's3' }), false);
});
