import assert from 'node:assert/strict';
import test from 'node:test';

import { executeLocalCommand, parseLocalCommand } from '../lib/client/local-commands.js';

function context() {
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    value: {
      help: record('help'),
      sessions: record('sessions'),
      agents: record('agents'),
      jobs: record('jobs'),
      jobOutput: record('jobOutput'),
      killJob: record('killJob'),
      previewAgents: record('previewAgents'),
      togglePeek: record('togglePeek'),
      parent: record('parent'),
      openSession: record('openSession'),
      newSession: record('newSession'),
      rename: record('rename'),
      cancel: record('cancel'),
      submitPrompt: record('submitPrompt'),
      queueManager: record('queueManager'),
      model: record('model'),
      status: record('status'),
      quit: record('quit'),
      note: record('note'),
    },
  };
}

test('parses command names and arguments', () => {
  assert.deepEqual(parseLocalCommand('  /ReName  My session  '), { name: '/rename', rest: 'My session' });
  assert.deepEqual(parseLocalCommand('/queue'), { name: '/queue', rest: '' });
});

test('dispatches local command handlers', async () => {
  const { value, calls } = context();
  const cases = [
    ['/help', ['help']],
    ['/sessions', ['sessions']],
    ['/agents', ['agents']],
    ['/jobs', ['jobs']],
    ['/job-output abc', ['jobOutput', 'abc']],
    ['/job-kill abc', ['killJob', 'abc']],
    ['/agents-preview review', ['previewAgents', 'review']],
    ['/peek', ['togglePeek']],
    ['/parent', ['parent']],
    ['/resume abc', ['openSession', 'abc']],
    ['/resume', ['sessions']],
    ['/new /tmp/work', ['newSession', '/tmp/work']],
    ['/rename Title', ['rename', 'Title']],
    ['/cancel', ['cancel']],
    ['/steer now', ['submitPrompt', 'now', 'steer']],
    ['/queue later', ['submitPrompt', 'later', 'queue']],
    ['/queue', ['queueManager']],
    ['/model provider/model', ['model', 'provider/model']],
    ['/model', ['model', '']],
    ['/status', ['status']],
    ['/quit', ['quit']],
    ['/exit', ['quit']],
  ];
  for (const [line, expected] of cases) {
    calls.length = 0;
    assert.equal(await executeLocalCommand(line, value), true, line);
    assert.deepEqual(calls, [expected], line);
  }
});

test('reports usage for commands with required arguments', async () => {
  const { value, calls } = context();
  for (const line of ['/job-output', '/job-kill', '/rename', '/steer']) {
    calls.length = 0;
    assert.equal(await executeLocalCommand(line, value), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'note');
    assert.match(calls[0][1], /^usage:/);
  }
});

test('leaves non-local commands to the Host', async () => {
  const { value, calls } = context();
  assert.equal(await executeLocalCommand('/compact', value), false);
  assert.deepEqual(calls, []);
});
