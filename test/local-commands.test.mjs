import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeLocalCommand,
  parseLocalCommand,
  parseNewSessionArgs,
  parseSessionArchiveArgs,
} from '../lib/client/local-commands.js';

function context() {
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    value: {
      help: record('help'),
      sessions: record('sessions'),
      agents: record('agents'),
      continueAgent: record('continueAgent'),
      interruptAgent: record('interruptAgent'),
      jobs: record('jobs'),
      skillsList: record('skillsList'),
      skillShow: record('skillShow'),
      skillRun: record('skillRun'),
      todos: record('todos'),
      detail: record('detail'),
      btw: record('btw'),
      approvals: record('approvals'),
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
      forkSession: record('forkSession'),
      archiveSession: record('archiveSession'),
      unarchiveSession: record('unarchiveSession'),
      pinSession: record('pinSession'),
      unpinSession: record('unpinSession'),
      sessionPresets: record('sessionPresets'),
      sessionPresetPicker: record('sessionPresetPicker'),
      sessionPreset: record('sessionPreset'),
      deleteSession: record('deleteSession'),
      rename: record('rename'),
      cancel: record('cancel'),
      submitPrompt: record('submitPrompt'),
      queueManager: record('queueManager'),
      goal: record('goal'),
      plan: record('plan'),
      find: record('find'),
      loadEarlierHistory: record('loadEarlierHistory'),
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

test('parses new-session options without splitting a cwd with spaces', () => {
  assert.deepEqual(parseNewSessionArgs(''), { cwd: '', agentPreset: '', invalid: false });
  assert.deepEqual(parseNewSessionArgs('/tmp/work'), { cwd: '/tmp/work', agentPreset: '', invalid: false });
  assert.deepEqual(parseNewSessionArgs('/tmp/work --preset standard'), {
    cwd: '/tmp/work',
    agentPreset: 'standard',
    invalid: false,
  });
  assert.deepEqual(parseNewSessionArgs('--preset=standard /tmp/my work'), {
    cwd: '/tmp/my work',
    agentPreset: 'standard',
    invalid: false,
  });
  assert.equal(parseNewSessionArgs('--preset').invalid, true);
  assert.equal(parseNewSessionArgs('--bogus').invalid, true);
  assert.deepEqual(parseSessionArchiveArgs('abc --stop'), {
    sessionId: 'abc',
    stopActivity: true,
    invalid: false,
  });
  assert.deepEqual(parseSessionArchiveArgs('abc'), {
    sessionId: 'abc',
    stopActivity: false,
    invalid: false,
  });
  assert.equal(parseSessionArchiveArgs('--bogus').invalid, true);
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
    ['/session fork', ['forkSession', '']],
    ['/session fork abc', ['forkSession', 'abc']],
    ['/session archive', ['archiveSession', '', { stopActivity: false }]],
    ['/session archive abc --stop', ['archiveSession', 'abc', { stopActivity: true }]],
    ['/session unarchive abc', ['unarchiveSession', 'abc']],
    ['/session pin', ['pinSession', '']],
    ['/session pin abc', ['pinSession', 'abc']],
    ['/session unpin', ['unpinSession', '']],
    ['/session unpin abc', ['unpinSession', 'abc']],
    ['/session presets', ['sessionPresets']],
    ['/session preset', ['sessionPresetPicker']],
    ['/session preset standard', ['sessionPreset', 'standard']],
    ['/session delete', ['deleteSession', '']],
    ['/session delete abc', ['deleteSession', 'abc']],
    ['/session new /tmp/work --preset standard', ['newSession', '/tmp/work', { agentPreset: 'standard' }]],
    ['/session new --preset standard /tmp/work', ['newSession', '/tmp/work', { agentPreset: 'standard' }]],
    ['/new /tmp/work --preset standard', ['newSession', '/tmp/work', { agentPreset: 'standard' }]],
    ['/subagent', ['agents']],
    ['/subagent list', ['agents']],
    ['/subagent preview 2', ['previewAgents', '2']],
    ['/subagent parent', ['parent']],
    ['/subagent peek', ['togglePeek']],
    ['/subagent continue', ['continueAgent', '']],
    ['/subagent continue child-1 hello world', ['continueAgent', 'child-1 hello world']],
    ['/subagent interrupt child-1', ['interruptAgent', 'child-1']],
    ['/subagent stop child-1', ['interruptAgent', 'child-1']],
    ['/subagent cancel', ['interruptAgent', '']],
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
    ['/detail', ['detail', '']],
    ['/detail verbose', ['detail', 'verbose']],
    ['/btw where?', ['btw', 'where?']],
    ['/approvals status', ['approvals', 'status']],
    ['/goal', ['goal', { kind: 'status' }]],
    ['/goal status', ['goal', { kind: 'status' }]],
    ['/goal pause', ['goal', { kind: 'pause' }]],
    ['/goal resume', ['goal', { kind: 'resume' }]],
    ['/goal clear', ['goal', { kind: 'clear' }]],
    ['/goal complete', ['goal', { kind: 'complete' }]],
    ['/goal edit fix the tests', ['goal', { kind: 'edit', objective: 'fix the tests' }]],
    ['/goal edit', ['goal', { kind: 'edit', objective: '' }]],
    ['/goal create ship it', ['goal', { kind: 'create', objective: 'ship it' }]],
    ['/goal ship it', ['goal', { kind: 'create', objective: 'ship it' }]],
    ['/goal create', ['goal', { kind: 'usage', message: 'usage: /goal create <objective>' }]],
    ['/plan', ['plan', { kind: 'enter' }]],
    ['/plan enter', ['plan', { kind: 'enter' }]],
    ['/plan on', ['plan', { kind: 'enter' }]],
    ['/plan off', ['plan', { kind: 'exit' }]],
    ['/plan exit', ['plan', { kind: 'exit' }]],
    ['/plan status', ['plan', { kind: 'status' }]],
    ['/plan approve', ['plan', { kind: 'approve' }]],
    ['/plan inspect the failing tests', ['plan', { kind: 'message', message: 'inspect the failing tests' }]],
    ['/plan edit the parser', ['plan', { kind: 'message', message: 'edit the parser' }]],
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
    ['/history', ['loadEarlierHistory']],
    ['/earlier', ['loadEarlierHistory']],
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
  for (const line of ['/job-output', '/job-kill', '/rename', '/steer', '/job output', '/job kill', '/skill show', '/skill run', '/skill bad', '/image bad', '/subagent bad', '/session rename', '/session unarchive', '/session new --preset', '/session archive --bogus', '/session bad']) {
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
