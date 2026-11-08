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
      skillsList: record('skillsList'),
      skillShow: record('skillShow'),
      skillRun: record('skillRun'),
      todos: record('todos'),
      jobOutput: record('jobOutput'),
      killJob: record('killJob'),
      previewAgents: record('previewAgents'),
      togglePeek: record('togglePeek'),
      pasteImage: record('pasteImage'),
      images: record('images'),
      clearImages: record('clearImages'),
      parent: record('parent'),
      openSession: record('openSession'),
      newSession: record('newSession'),
      rename: record('rename'),
      cancel: record('cancel'),
      submitPrompt: record('submitPrompt'),
      queueManager: record('queueManager'),
      find: record('find'),
      model: record('model'),
      permission: record('permission'),
      status: record('status'),
      quit: record('quit'),
      reconnect: record('reconnect'),
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
    ['/session', ['sessions']],
    ['/session list', ['sessions']],
    ['/session new /tmp/work', ['newSession', '/tmp/work']],
    ['/session resume abc', ['openSession', 'abc']],
    ['/session resume', ['sessions']],
    ['/session rename Title', ['rename', 'Title']],
    ['/subagent', ['agents']],
    ['/subagent list', ['agents']],
    ['/subagent preview 2', ['previewAgents', '2']],
    ['/subagent parent', ['parent']],
    ['/subagent peek', ['togglePeek']],
    ['/image', ['images']],
    ['/image list', ['images']],
    ['/image paste', ['pasteImage']],
    ['/image clear', ['clearImages']],
    ['/job', ['jobs']],
    ['/job list', ['jobs']],
    ['/job output abc', ['jobOutput', 'abc']],
    ['/job kill abc', ['killJob', 'abc']],
    ['/skill', ['skillsList']],
    ['/skill list', ['skillsList']],
    ['/skill show clojure-eval', ['skillShow', 'clojure-eval']],
    ['/skill run clojure-eval', ['skillRun', 'clojure-eval']],
    ['/todo', ['todos']],
    ['/todos', ['todos']],
    ['/sessions', ['sessions']],
    ['/reconnect', ['reconnect']],
    ['/subagents', ['agents']],
    ['/agents', ['agents']],
    ['/jobs', ['jobs']],
    ['/job-output abc', ['jobOutput', 'abc']],
    ['/job-kill abc', ['killJob', 'abc']],
    ['/subagents-preview review', ['previewAgents', 'review']],
    ['/agents-preview review', ['previewAgents', 'review']],
    ['/peek', ['togglePeek']],
    ['/paste-image', ['pasteImage']],
    ['/images', ['images']],
    ['/images clear', ['clearImages']],
    ['/parent', ['parent']],
    ['/resume abc', ['openSession', 'abc']],
    ['/resume', ['sessions']],
    ['/new /tmp/work', ['newSession', '/tmp/work']],
    ['/rename Title', ['rename', 'Title']],
    ['/cancel', ['cancel']],
    ['/steer now', ['submitPrompt', 'now', 'steer']],
    ['/queue later', ['submitPrompt', 'later', 'queue']],
    ['/queue', ['queueManager']],
    ['/find retry', ['find', 'retry']],
    ['/find', ['find', '']],
    ['/model provider/model', ['model', 'provider/model']],
    ['/model', ['model', '']],
    ['/permission', ['permission', '']],
    ['/permission workspace-write', ['permission', 'workspace-write']],
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
  for (const line of ['/job-output', '/job-kill', '/rename', '/steer', '/job output', '/job kill', '/skill show', '/skill run', '/skill bad', '/image bad', '/subagent bad', '/session rename', '/session bad']) {
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
