import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { runExec } from '../lib/client/exec.js';
import { normalizeAutoApprovalConfig } from '../lib/client/auto-approval.js';

function frame(client, sessionId, type, data, extra = {}) {
  client.emit('frame', {
    sessionId,
    frame: { type: 'event', event: { type, ...extra, data } },
  });
}

function assistant(client, sessionId, text, usage = undefined) {
  frame(client, sessionId, 'assistant/message', {
    message: { content: [{ type: 'text', text }] },
    ...(usage === undefined ? {} : { usage }),
  });
}

function streamChunk(client, sessionId, chunk) {
  client.emit('frame', {
    sessionId,
    frame: {
      type: 'assistant-stream',
      frame: { type: 'chunk', turn: 1, step: 0, attemptId: 'a1', chunk },
    },
  });
}

function finish(client, sessionId, reason = { kind: 'complete' }) {
  frame(client, sessionId, 'turn/end', { turn: 1, reason });
}

function fakeClient({ sessionId = 's1', items = [], onPrompt } = {}) {
  const client = new EventEmitter();
  client.requests = [];
  client.request = async (method, params = {}) => {
    client.requests.push({ method, params });
    switch (method) {
      case 'session.create':
        return { sessionId };
      case 'session.list':
        return { items };
      case 'session.open':
        client.emit('frame', { sessionId: params.sessionId, frame: { type: 'snapshot' } });
        return { sessionId: params.sessionId };
      case 'session.prompt':
        onPrompt?.(client, params);
        return { accepted: true };
      case 'session.close':
      case 'session.cancel':
      case 'approval.respond':
      case 'question.cancel':
        return { accepted: true };
      case 'sandbox.allowDir':
        return { supported: true, directory: params.directory, registered: true, directories: [params.directory], pending: [] };
      case 'commands.execute':
        return { executed: true, commandId: 'permission', result: undefined };
      case 'session.selectModel':
        return { selection: { provider: params.provider, model: params.model } };
      case 'session.rename':
        return { renamed: true };
      default:
        throw new Error(`unexpected request ${method}`);
    }
  };
  return client;
}

test('rejects an empty prompt before touching the Host', async () => {
  const client = fakeClient();
  await assert.rejects(
    runExec(client, { prompt: '   ' }),
    (error) => error?.code === 'attach/exec-input',
  );
  assert.deepEqual(client.requests, []);
});

test('fails when the Host creates no session', async () => {
  const client = new EventEmitter();
  client.request = async (method) => {
    if (method === 'session.create') return {};
    if (method === 'session.close') return {};
    throw new Error(`unexpected request ${method}`);
  };
  await assert.rejects(
    runExec(client, { prompt: 'work' }),
    (error) => error?.code === 'attach/exec-create',
  );
});

test('creates a session, sends one prompt, and returns the final answer', async () => {
  const warnings = [];
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'user/message', { content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      assistant(fake, 'new-1', 'done', { inputTokens: 2, outputTokens: 3 });
      finish(fake, 'new-1');
    },
  });
  const result = await runExec(client, { prompt: 'do it', cwd: '/work', warn: (line) => warnings.push(line) });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'new-1');
  assert.equal(result.text, 'done');
  assert.equal(result.reason, 'complete');
  assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 3 });
  assert.deepEqual(result.interactions, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(client.requests.map((entry) => entry.method), [
    'session.create',
    'session.open',
    'session.prompt',
    'session.close',
  ]);
  assert.deepEqual(client.requests[0].params, { cwd: '/work' });
});

test('reuses an idle session', async () => {
  const client = fakeClient({
    items: [{ sessionId: 's1', running: false }],
    onPrompt: (fake) => {
      frame(fake, 's1', 'turn/start', { turn: 1 });
      assistant(fake, 's1', 'continued');
      finish(fake, 's1');
    },
  });
  const result = await runExec(client, { sessionId: 's1', prompt: 'continue' });
  assert.equal(result.sessionId, 's1');
  assert.equal(result.text, 'continued');
  assert.equal(client.requests[0].method, 'session.list');
  assert.equal(client.requests[1].method, 'session.open');
});

test('rejects a session that is already running', async () => {
  const client = fakeClient({ items: [{ sessionId: 's1', running: true }] });
  await assert.rejects(
    runExec(client, { sessionId: 's1', prompt: 'later' }),
    (error) => error?.code === 'attach/exec-busy',
  );
  assert.equal(client.requests.some((entry) => entry.method === 'session.prompt'), false);
});

test('rejects approvals and cancels questions instead of waiting', async () => {
  const warnings = [];
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      fake.emit('interactive', {
        type: 'approval',
        requestId: 'a1',
        sessionId: 'new-1',
        toolName: 'bash',
        reason: 'needs write access',
      });
      fake.emit('interactive', {
        type: 'question',
        requestId: 'q1',
        sessionId: 'new-1',
        questions: [{ question: 'Which file?' }],
      });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      assistant(fake, 'new-1', 'could not continue');
      finish(fake, 'new-1');
    },
  });
  const result = await runExec(client, { prompt: 'work', warn: (line) => warnings.push(line) });
  assert.equal(result.ok, true);
  assert.equal(result.interactions.length, 2);
  assert.equal(result.interactions[0].type, 'approval');
  assert.equal(result.interactions[0].tool, 'bash');
  assert.equal(result.interactions[0].outcome, 'rejected');
  assert.equal(result.interactions[1].type, 'question');
  assert.equal(result.interactions[1].outcome, 'cancelled');
  assert.equal(warnings.some((line) => /rejected approval for bash/.test(line)), true);
  assert.equal(warnings.some((line) => /cancelled a question/.test(line)), true);
  assert.equal(client.requests.some((entry) => entry.method === 'approval.respond'), true);
  assert.equal(client.requests.some((entry) => entry.method === 'question.cancel'), true);
});

test('delegates approvals to DSH when approvals is host', async () => {
  const warnings = [];
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      fake.emit('interactive', {
        type: 'approval',
        requestId: 'a-host',
        sessionId: 'new-1',
        toolName: 'bash',
        reason: 'needs review',
      });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      assistant(fake, 'new-1', 'continued');
      finish(fake, 'new-1');
    },
  });
  const result = await runExec(client, { prompt: 'work', approvals: 'host', warn: (line) => warnings.push(line) });
  assert.equal(result.interactions[0].outcome, 'delegated');
  assert.equal(warnings.some((line) => /delegated approval for bash/.test(line)), true);
  assert.equal(client.requests.some((entry) => entry.method === 'interactive.delegate'), true);
  assert.equal(client.requests.some((entry) => entry.method === 'approval.respond'), false);
});

test('applies matching approval rules before rejecting', async () => {
  const warnings = [];
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'tool/call', {
        callId: 'tool-1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'npm test -- --runInBand' }),
      });
      fake.emit('interactive', {
        type: 'approval',
        requestId: 'rule-1',
        sessionId: 'new-1',
        toolName: 'bash',
        callId: 'tool-1',
        reason: 'run tests',
      });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  const approvalRules = normalizeAutoApprovalConfig({
    enabled: true,
    mode: 'rules',
    rules: [{ id: 'tests', tool: 'bash', commandPrefix: ['npm', 'test'] }],
  });
  const result = await runExec(client, {
    prompt: 'work',
    approvalRules,
    warn: (line) => warnings.push(line),
  });
  assert.equal(result.interactions[0].outcome, 'allowed-once');
  assert.equal(result.interactions[0].decision, 'rule:tests');
  assert.equal(warnings.some((line) => /auto-approved bash/.test(line)), true);
  const response = client.requests.find((entry) => entry.method === 'approval.respond');
  assert.equal(response.params.outcome, 'allowed-once');
});

test('uses the Host reviewer in review mode', async () => {
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      fake.emit('interactive', {
        type: 'approval',
        requestId: 'review-1',
        sessionId: 'new-1',
        toolName: 'bash',
        reason: 'safe command',
      });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  const request = client.request;
  client.request = async (method, params) => {
    if (method === 'approval.review') return { verdict: 'allow', reason: 'safe' };
    return request(method, params);
  };
  const approvalRules = normalizeAutoApprovalConfig({
    enabled: true,
    mode: 'review',
    policy: 'allow safe read-only commands',
  });
  const result = await runExec(client, { prompt: 'work', approvalRules });
  assert.equal(result.interactions[0].outcome, 'allowed-once');
  assert.match(result.interactions[0].decision, /rule review/);
});

test('falls back when no approval rule matches', async () => {
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'tool/call', {
        callId: 'tool-2',
        name: 'bash',
        arguments: JSON.stringify({ command: 'rm -rf build' }),
      });
      fake.emit('interactive', {
        type: 'approval',
        requestId: 'rule-2',
        sessionId: 'new-1',
        toolName: 'bash',
        callId: 'tool-2',
      });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  const approvalRules = normalizeAutoApprovalConfig({
    enabled: true,
    mode: 'rules',
    rules: [{ id: 'tests', tool: 'bash', commandPrefix: ['npm', 'test'] }],
  });
  const result = await runExec(client, { prompt: 'work', approvalRules });
  assert.equal(result.interactions[0].outcome, 'rejected');
  assert.equal(result.interactions[0].decision, 'non-interactive exec mode');
  const response = client.requests.find((entry) => entry.method === 'approval.respond');
  assert.equal(response.params.outcome, 'rejected');
});

test('delegates unmatched approvals when rules and host mode are combined', async () => {
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'tool/call', {
        callId: 'tool-3',
        name: 'bash',
        arguments: JSON.stringify({ command: 'git push origin main' }),
      });
      fake.emit('interactive', {
        type: 'approval',
        requestId: 'rule-3',
        sessionId: 'new-1',
        toolName: 'bash',
        callId: 'tool-3',
      });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  const approvalRules = normalizeAutoApprovalConfig({
    enabled: true,
    mode: 'rules',
    rules: [{ id: 'tests', tool: 'bash', commandPrefix: ['npm', 'test'] }],
  });
  const result = await runExec(client, {
    prompt: 'work',
    approvals: 'host',
    approvalRules,
  });
  assert.equal(result.interactions[0].outcome, 'delegated');
  assert.equal(client.requests.some((entry) => entry.method === 'interactive.delegate'), true);
});

test('--approve allows approvals when explicitly requested', async () => {
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      fake.emit('interactive', {
        type: 'approval',
        requestId: 'a1',
        sessionId: 'new-1',
        toolName: 'bash',
        reason: 'needs write access',
      });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  const result = await runExec(client, { prompt: 'work', approve: true });
  assert.equal(result.interactions[0].outcome, 'allowed-once');
  const response = client.requests.find((entry) => entry.method === 'approval.respond');
  assert.equal(response.params.outcome, 'allowed-once');
});

test('reports a failed turn', async () => {
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      assistant(fake, 'new-1', 'partial');
      finish(fake, 'new-1', { kind: 'error', error: { message: 'quota exceeded', code: 'quota', status: 429 } });
    },
  });
  const result = await runExec(client, { prompt: 'work' });
  assert.equal(result.ok, false);
  assert.equal(result.text, 'partial');
  assert.equal(result.reason, 'error');
  assert.equal(result.failure.message, 'quota exceeded');
  assert.equal(result.failure.code, 'quota');
  assert.equal(result.failure.status, 429);
});

test('propagates a prompt submission failure', async () => {
  const client = fakeClient({ sessionId: 'new-1' });
  const request = client.request;
  client.request = async (method, params) => {
    if (method === 'session.prompt') throw new Error('prompt rejected');
    return request(method, params);
  };
  await assert.rejects(
    runExec(client, { prompt: 'work' }),
    /prompt rejected/,
  );
  assert.equal(client.requests.some((entry) => entry.method === 'session.close'), true);
});

test('surfaces a session error during a turn', async () => {
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      fake.emit('session-error', {
        sessionId: 'new-1',
        error: { message: 'follow failed', code: 'attach/follow' },
      });
    },
  });
  await assert.rejects(
    runExec(client, { prompt: 'work' }),
    (error) => error?.code === 'attach/follow'
      && /follow failed/.test(error.message)
      && error?.sessionId === 'new-1',
  );
});

test('fails when the Host closes during a turn', async () => {
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      fake.emit('close', new Error('gone'));
    },
  });
  await assert.rejects(
    runExec(client, { prompt: 'work' }),
    (error) => error?.code === 'attach/closed' && error?.sessionId === 'new-1',
  );
});

test('times out and cancels a stalled turn', async () => {
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
    },
  });
  await assert.rejects(
    runExec(client, { prompt: 'slow', timeoutMs: 15 }),
    (error) => error?.code === 'attach/exec-timeout',
  );
  assert.equal(client.requests.some((entry) => entry.method === 'session.cancel'), true);
  assert.equal(client.requests.some((entry) => entry.method === 'session.close'), true);
});

test('ignores interactions from another session', async () => {
  const warnings = [];
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      fake.emit('interactive', {
        type: 'approval',
        requestId: 'other',
        sessionId: 'other-session',
        toolName: 'bash',
      });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  const result = await runExec(client, { prompt: 'work', warn: (line) => warnings.push(line) });
  assert.deepEqual(result.interactions, []);
  assert.deepEqual(warnings, []);
});

test('removes the interactive listener after every run', async () => {
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      assistant(fake, 'new-1', 'done');
      finish(fake, 'new-1');
    },
  });
  await runExec(client, { prompt: 'one' });
  await runExec(client, { prompt: 'two' });
  assert.equal(client.listenerCount('interactive'), 0);
  assert.equal(client.listenerCount('frame'), 0);
  assert.equal(client.listenerCount('session-error'), 0);
  assert.equal(client.listenerCount('close'), 0);
});

test('forwards the Host displayReason to the exec reviewer', async () => {
  const payloads = [];
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      fake.emit('interactive', {
        type: 'approval',
        requestId: 'review-display',
        sessionId: 'new-1',
        toolName: 'bash',
        reason: 'needs write access',
        displayReason: { en: 'Needs write access', zh: '需要写入权限' },
      });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  const request = client.request;
  client.request = async (method, params) => {
    if (method === 'approval.review') {
      payloads.push(params.payload);
      return { verdict: 'allow', reason: 'safe' };
    }
    return request(method, params);
  };
  const approvalRules = normalizeAutoApprovalConfig({
    enabled: true,
    mode: 'review',
    policy: 'allow safe read-only commands',
  });
  await runExec(client, { prompt: 'work', approvalRules });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].displayReason, '需要写入权限');
});

test('preserves the created session id on timeout and failure', async () => {
  const client = fakeClient({
    sessionId: 'new-timeout',
    onPrompt: (fake) => {
      frame(fake, 'new-timeout', 'turn/start', { turn: 1 });
    },
  });
  await assert.rejects(
    runExec(client, { prompt: 'slow', timeoutMs: 15 }),
    (error) => error?.code === 'attach/exec-timeout' && error?.sessionId === 'new-timeout',
  );
});

test('preserves the requested session id when the session is missing', async () => {
  const client = fakeClient({ items: [] });
  await assert.rejects(
    runExec(client, { sessionId: 'missing-session', prompt: 'work' }),
    (error) => error?.code === 'attach/exec-session' && error?.sessionId === 'missing-session',
  );
});

test('reports the session immediately after session.open', async () => {
  const seen = [];
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      assistant(fake, 'new-1', 'done');
      finish(fake, 'new-1');
    },
  });
  const request = client.request;
  client.request = async (method, params) => {
    if (method === 'session.open') {
      client.emit('frame', {
        sessionId: params.sessionId,
        frame: { type: 'snapshot', header: { cwd: '/real/work' } },
      });
      return { sessionId: params.sessionId };
    }
    return request(method, params);
  };
  const result = await runExec(client, {
    prompt: 'work',
    onSession: (sessionId, facts) => seen.push({ sessionId, facts }),
  });
  assert.equal(result.sessionId, 'new-1');
  assert.deepEqual(seen, [{ sessionId: 'new-1', facts: { cwd: '/real/work' } }]);
});

test('registers every --allow-dir root before the prompt', async () => {
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  await runExec(client, { prompt: 'work', allowDirs: ['/shared', '/cache'] });
  const calls = client.requests.map((entry) => entry.method);
  assert.deepEqual(
    client.requests.filter((entry) => entry.method === 'sandbox.allowDir').map((entry) => entry.params.directory),
    ['/shared', '/cache'],
  );
  assert.ok(calls.indexOf('sandbox.allowDir') < calls.indexOf('session.prompt'));
});

test('fails fast when --allow-dir is unsupported or rejected', async () => {
  const unsupported = fakeClient({ sessionId: 'new-1' });
  unsupported.host = { capabilities: [] };
  await assert.rejects(
    runExec(unsupported, { prompt: 'work', allowDirs: ['/shared'] }),
    (error) => error?.code === 'attach/exec-allow-dir' && /sandbox\.roots/u.test(error.message),
  );
  assert.equal(
    unsupported.requests.some((entry) => entry.method === 'sandbox.allowDir' || entry.method === 'session.prompt'),
    false,
  );

  const rejected = fakeClient({ sessionId: 'new-1' });
  const request = rejected.request;
  rejected.request = async (method, params) => {
    if (method === 'sandbox.allowDir') {
      throw Object.assign(new Error('not a directory'), { code: 'attach/invalid-root' });
    }
    return request(method, params);
  };
  await assert.rejects(
    runExec(rejected, { prompt: 'work', allowDirs: ['/missing'] }),
    (error) => error?.code === 'attach/exec-allow-dir' && /not a directory/u.test(error.message),
  );
  assert.equal(rejected.requests.some((entry) => entry.method === 'session.prompt'), false);
});

test('accepts a pending writable root for a new or idle session, but fails when neither registered nor pending', async () => {
  const pendingClient = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  const pendingRequest = pendingClient.request;
  pendingClient.request = async (method, params) => {
    if (method === 'sandbox.allowDir') {
      return { supported: true, directory: params.directory, registered: false, pending: [params.directory], directories: [] };
    }
    return pendingRequest(method, params);
  };
  const result = await runExec(pendingClient, { prompt: 'work', allowDirs: ['/shared'] });
  assert.equal(result.ok, true);

  const failedClient = fakeClient({ sessionId: 'new-1' });
  const failedRequest = failedClient.request;
  failedClient.request = async (method, params) => {
    if (method === 'sandbox.allowDir') {
      return { supported: true, directory: params.directory, registered: false, pending: [], directories: [] };
    }
    return failedRequest(method, params);
  };
  await assert.rejects(
    runExec(failedClient, { prompt: 'work', allowDirs: ['/shared'] }),
    (error) => error?.code === 'attach/exec-allow-dir' && /did not register/u.test(error.message),
  );
});

test('applies --permission before the prompt', async () => {
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  await runExec(client, { prompt: 'work', permission: 'workspace-write' });
  const command = client.requests.find((entry) => entry.method === 'commands.execute');
  assert.equal(command.params.line, '/permission workspace-write');
  const methods = client.requests.map((entry) => entry.method);
  assert.ok(methods.indexOf('commands.execute') < methods.indexOf('session.prompt'));
});

test('validates --permission and --model before touching the Host', async () => {
  const client = fakeClient();
  await assert.rejects(
    runExec(client, { prompt: 'work', permission: 'root' }),
    (error) => error?.code === 'attach/exec-permission',
  );
  await assert.rejects(
    runExec(client, { prompt: 'work', model: 'no-slash' }),
    (error) => error?.code === 'attach/exec-model',
  );
  assert.deepEqual(client.requests, []);
});

test('fails clearly when the Host rejects --permission', async () => {
  const client = fakeClient({ sessionId: 'new-1' });
  const request = client.request;
  client.request = async (method, params) => {
    if (method === 'commands.execute') return { executed: false };
    return request(method, params);
  };
  await assert.rejects(
    runExec(client, { prompt: 'work', permission: 'auto' }),
    (error) => error?.code === 'attach/exec-permission' && /cannot apply/u.test(error.message),
  );
});

test('selects --model with the provider/model split at the first slash', async () => {
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  await runExec(client, { prompt: 'work', model: 'openrouter/anthropic/claude' });
  const selection = client.requests.find((entry) => entry.method === 'session.selectModel');
  assert.deepEqual(selection.params, { provider: 'openrouter', model: 'anthropic/claude' });
});

test('creates a new session with --preset and rejects it with --session', async () => {
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  await runExec(client, { prompt: 'work', cwd: '/work', preset: 'minimal' });
  assert.deepEqual(client.requests[0].params, { cwd: '/work', agentPreset: 'minimal' });

  const reused = fakeClient({ items: [{ sessionId: 's1', running: false }] });
  await assert.rejects(
    runExec(reused, { sessionId: 's1', prompt: 'work', preset: 'minimal' }),
    (error) => error?.code === 'attach/exec-preset',
  );
});

test('renames the session with --title', async () => {
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  await runExec(client, { prompt: 'work', title: '  nightly run  ' });
  const rename = client.requests.find((entry) => entry.method === 'session.rename');
  assert.deepEqual(rename.params, { sessionId: 'new-1', title: 'nightly run' });
  await assert.rejects(
    runExec(fakeClient(), { prompt: 'work', title: '  ' }),
    (error) => error?.code === 'attach/exec-title',
  );
});

test('streams tool calls and interactions through observer callbacks', async () => {
  const toolCalls = [];
  const interactions = [];
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'tool/call', { callId: 'tool-1', name: 'bash', arguments: '{}' });
      fake.emit('interactive', {
        type: 'approval',
        requestId: 'a1',
        sessionId: 'new-1',
        toolName: 'bash',
        callId: 'tool-1',
      });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  await runExec(client, {
    prompt: 'work',
    onToolCall: (call) => toolCalls.push(call),
    onInteraction: (record) => interactions.push(record),
  });
  assert.deepEqual(toolCalls, [{
    sessionId: 'new-1',
    callId: 'tool-1',
    name: 'bash',
    arguments: '{}',
  }]);
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].type, 'approval');
  assert.equal(interactions[0].outcome, 'rejected');
});

test('streams text and reasoning deltas only while awaiting the turn', async () => {
  const deltas = [];
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      streamChunk(fake, 'new-1', { type: 'text-delta', text: 'hel' });
      streamChunk(fake, 'new-1', { type: 'reasoning-delta', text: 'thinking' });
      streamChunk(fake, 'new-1', { type: 'text-delta', text: '' });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      assistant(fake, 'new-1', 'hello');
      finish(fake, 'new-1');
      streamChunk(fake, 'new-1', { type: 'text-delta', text: 'after the turn' });
    },
  });
  const request = client.request;
  client.request = async (method, params) => {
    if (method === 'session.open') {
      const value = await request(method, params);
      // The snapshot arrived, but the prompt has not been submitted yet.
      streamChunk(client, params.sessionId, { type: 'text-delta', text: 'pre-prompt' });
      return value;
    }
    return request(method, params);
  };
  const result = await runExec(client, {
    prompt: 'work',
    onTextDelta: (delta) => deltas.push({ kind: 'text', ...delta }),
    onReasoningDelta: (delta) => deltas.push({ kind: 'reasoning', ...delta }),
  });
  assert.equal(result.text, 'hello');
  assert.deepEqual(deltas, [
    { kind: 'text', sessionId: 'new-1', text: 'hel' },
    { kind: 'reasoning', sessionId: 'new-1', text: 'thinking' },
  ]);
});

test('tool calls carry stringified, bounded arguments', async () => {
  const toolCalls = [];
  const oversized = 'x'.repeat(20_000);
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'tool/call', {
        callId: 'tool-1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'npm test' }),
      });
      frame(fake, 'new-1', 'tool/call', {
        callId: 'tool-2',
        name: 'write',
        arguments: { path: 'README.md', content: 'hi' },
      });
      frame(fake, 'new-1', 'tool/call', {
        callId: 'tool-3',
        name: 'read',
        arguments: oversized,
      });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  await runExec(client, { prompt: 'work', onToolCall: (call) => toolCalls.push(call) });
  assert.deepEqual(toolCalls[0], {
    sessionId: 'new-1',
    callId: 'tool-1',
    name: 'bash',
    arguments: '{"command":"npm test"}',
  });
  assert.deepEqual(toolCalls[1], {
    sessionId: 'new-1',
    callId: 'tool-2',
    name: 'write',
    arguments: '{"path":"README.md","content":"hi"}',
  });
  assert.equal(toolCalls[2].arguments.length, 16_384);
  assert.equal(toolCalls[2].truncated, true);
  assert.equal(toolCalls[0].truncated, undefined);
});

test('tool results carry readable output and error status', async () => {
  const results = [];
  const oversized = 'y'.repeat(20_000);
  const client = fakeClient({
    sessionId: 'new-1',
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'tool/call', { callId: 'tool-1', name: 'bash', arguments: '{}' });
      frame(fake, 'new-1', 'tool/call', { callId: 'tool-2', name: 'read', arguments: '{}' });
      frame(fake, 'new-1', 'tool/call', { callId: 'tool-3', name: 'write', arguments: '{}' });
      frame(fake, 'new-1', 'tool/result', {
        message: { toolCallId: 'tool-1', content: [{ type: 'text', text: '2 tests passed' }] },
      });
      frame(fake, 'new-1', 'tool/result', {
        message: { toolCallId: 'tool-2', content: [], isError: true },
        error: { message: 'permission denied' },
      });
      frame(fake, 'new-1', 'tool/result', {
        message: { toolCallId: 'tool-3', content: [{ type: 'text', text: oversized }] },
      });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      finish(fake, 'new-1');
    },
  });
  await runExec(client, { prompt: 'work', onToolResult: (result) => results.push(result) });
  assert.deepEqual(results[0], {
    sessionId: 'new-1',
    callId: 'tool-1',
    name: 'bash',
    ok: true,
    output: '2 tests passed',
  });
  assert.deepEqual(results[1], {
    sessionId: 'new-1',
    callId: 'tool-2',
    name: 'read',
    ok: false,
    output: 'permission denied',
  });
  assert.equal(results[2].ok, true);
  assert.equal(results[2].output.length, 16_384);
  assert.equal(results[2].truncated, true);
  assert.equal(results[0].truncated, undefined);
});

test('preserves the session id when interrupted', async () => {
  const client = fakeClient({ sessionId: 'new-interrupt' });
  const running = runExec(client, { prompt: 'slow', timeoutMs: 0 });
  const deadline = Date.now() + 1_000;
  while (!client.requests.some((entry) => entry.method === 'session.prompt') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  process.emit('SIGINT');
  await assert.rejects(
    running,
    (error) => error?.code === 'attach/exec-interrupted' && error?.sessionId === 'new-interrupt',
  );
});

test('SIGTERM cancels the turn, preserves the session id, and cleans up listeners', async () => {
  const client = fakeClient({ sessionId: 'new-term' });
  const sigtermListeners = process.listenerCount('SIGTERM');
  const sigintListeners = process.listenerCount('SIGINT');
  const running = runExec(client, { prompt: 'slow', timeoutMs: 0 });
  const deadline = Date.now() + 1_000;
  while (!client.requests.some((entry) => entry.method === 'session.prompt') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  process.emit('SIGTERM');
  await assert.rejects(
    running,
    (error) => error?.code === 'attach/exec-interrupted'
      && error?.message === 'exec terminated'
      && error?.signal === 'SIGTERM'
      && error?.sessionId === 'new-term',
  );
  assert.equal(client.requests.some((entry) => entry.method === 'session.cancel'), true);
  assert.equal(process.listenerCount('SIGTERM'), sigtermListeners);
  assert.equal(process.listenerCount('SIGINT'), sigintListeners);
});

test('reports unsupported and rejected sandbox responses', async () => {
  const unsupported = fakeClient({ sessionId: 'new-1' });
  const unsupportedRequest = unsupported.request;
  unsupported.request = async (method, params) => {
    if (method === 'sandbox.allowDir') return { supported: false, directory: params.directory, registered: false };
    return unsupportedRequest(method, params);
  };
  await assert.rejects(
    runExec(unsupported, { prompt: 'work', allowDirs: ['/shared'] }),
    (error) => error?.code === 'attach/exec-allow-dir' && /does not support/u.test(error.message),
  );

  const rejected = fakeClient({ sessionId: 'new-1' });
  const rejectedRequest = rejected.request;
  rejected.request = async (method, params) => {
    if (method === 'sandbox.allowDir') {
      return { supported: true, directory: params.directory, registered: false, error: 'SANDBOX_INVALID_ROOT' };
    }
    return rejectedRequest(method, params);
  };
  await assert.rejects(
    runExec(rejected, { prompt: 'work', allowDirs: ['/shared'] }),
    (error) => error?.code === 'attach/exec-allow-dir' && /SANDBOX_INVALID_ROOT/u.test(error.message),
  );
});

test('fails clearly when the Host has no command registry', async () => {
  const client = fakeClient({ sessionId: 'new-1' });
  client.host = { capabilities: [] };
  await assert.rejects(
    runExec(client, { prompt: 'work', permission: 'auto' }),
    (error) => error?.code === 'attach/exec-permission' && /commands are unavailable/u.test(error.message),
  );
});

function snapshotFrame(sessionId, records) {
  return {
    sessionId,
    frame: {
      type: 'snapshot',
      header: { id: sessionId, cwd: '/work' },
      cursor: records.length,
      records,
      hasMore: false,
      projections: { asOfSeq: records.length, values: {} },
    },
  };
}

function eventRecord(type, data) {
  return { seq: 1, type: 'event', event: { type, data } };
}

/** Drive a fake transport drop right after the prompt is queued. */
function droppingClient({ onPrompt }) {
  const client = fakeClient({ sessionId: 'new-1', onPrompt });
  let drop = true;
  const request = client.request;
  client.request = async (method, params) => {
    const value = await request(method, params);
    return value;
  };
  // The close is emitted from `onPrompt`, after the Host accepted the prompt.
  client.dropOnce = () => {
    if (!drop) return;
    drop = false;
    client.emit('close', new Error('network drop'));
  };
  return client;
}

test('remote exec reconnects mid-turn and resumes waiting for turn/end', async () => {
  let client;
  let reconnects = 0;
  client = droppingClient({
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'user/message', { content: [{ type: 'text', text: 'work' }] });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      assistant(fake, 'new-1', 'partial');
      fake.dropOnce();
    },
  });
  client.reconnect = async () => {
    reconnects += 1;
    setTimeout(() => {
      assistant(client, 'new-1', 'finished after reconnect');
      finish(client, 'new-1');
    }, 20);
  };
  const result = await runExec(client, {
    prompt: 'work',
    allowDirs: ['/shared'],
    ssh: 'host',
    reconnect: client.reconnect,
    reconnectWindowMs: 5_000,
  });
  assert.equal(reconnects, 1);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'finished after reconnect');
  const allowDirCalls = client.requests.filter((entry) => entry.method === 'sandbox.allowDir');
  assert.equal(allowDirCalls.length, 2, 'the initial grant and the post-reconnect re-grant');
  assert.deepEqual(allowDirCalls.map((entry) => entry.params), [
    { directory: '/shared' },
    { directory: '/shared' },
  ]);
  const opens = client.requests.filter((entry) => entry.method === 'session.open');
  assert.equal(opens.length, 2, 'the session is re-opened on the fresh connection');
});

test('remote exec recovers a turn that already finished while disconnected', async () => {
  let client;
  let reconnected = false;
  client = droppingClient({
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'user/message', { content: [{ type: 'text', text: 'work' }] });
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      assistant(fake, 'new-1', 'partial');
      fake.dropOnce();
    },
  });
  client.reconnect = async () => {
    reconnected = true;
  };
  const request = client.request;
  client.request = async (method, params) => {
    if (method === 'session.open' && reconnected) {
      client.emit('frame', snapshotFrame('new-1', [
        eventRecord('user/message', { content: [{ type: 'text', text: 'work' }] }),
        eventRecord('turn/start', { turn: 2 }),
        eventRecord('assistant/message', {
          message: { content: [{ type: 'text', text: 'finished while away' }] },
          usage: { inputTokens: 7, outputTokens: 8 },
        }),
        eventRecord('turn/end', { turn: 2, reason: { kind: 'complete' } }),
      ]));
      return { sessionId: params.sessionId };
    }
    return request(method, params);
  };
  const result = await runExec(client, {
    prompt: 'work',
    ssh: 'host',
    reconnect: client.reconnect,
    reconnectWindowMs: 5_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'finished while away');
  assert.equal(result.turn, 2);
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 8 });
  assert.equal(result.reason, 'complete');
  assert.equal(result.sessionId, 'new-1');
});

test('remote exec fails with attach/closed and preserves sessionId when reconnect expires', async () => {
  let reconnects = 0;
  const client = droppingClient({
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      fake.dropOnce();
    },
  });
  client.reconnect = async () => {
    reconnects += 1;
    throw new Error('still down');
  };
  await assert.rejects(
    runExec(client, {
      prompt: 'work',
      ssh: 'host',
      reconnect: client.reconnect,
      reconnectWindowMs: 60,
    }),
    (error) => error?.code === 'attach/closed'
      && error?.sessionId === 'new-1'
      && /did not recover/u.test(error.message),
  );
  assert.ok(reconnects >= 1, 'it tried to reconnect before giving up');
});

test('remote exec stops retrying on a fatal SSH error', async () => {
  const client = droppingClient({
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'turn/start', { turn: 1 });
      fake.dropOnce();
    },
  });
  let reconnects = 0;
  client.reconnect = async () => {
    reconnects += 1;
    throw Object.assign(new Error('Permission denied (publickey).'), { code: 'attach/ssh-auth' });
  };
  await assert.rejects(
    runExec(client, {
      prompt: 'work',
      ssh: 'host',
      reconnect: client.reconnect,
      reconnectWindowMs: 5_000,
    }),
    (error) => error?.code === 'attach/ssh-auth' && error?.sessionId === 'new-1',
  );
  assert.equal(reconnects, 1, 'fatal authentication errors are not retried');
});

test('remote exec does not mistake an older history turn for the reconnected turn', async () => {
  let client;
  let reconnected = false;
  let opens = 0;
  const oldHistory = [
    { seq: 5, type: 'event', event: { type: 'user/message', data: { content: [{ type: 'text', text: 'old' }] } } },
    { seq: 6, type: 'event', event: { type: 'turn/start', data: { turn: 1 } } },
    {
      seq: 7,
      type: 'event',
      event: {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'old answer' }] } },
      },
    },
    { seq: 8, type: 'event', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } } },
  ];
  client = droppingClient({
    onPrompt: (fake) => {
      frame(fake, 'new-1', 'user/message', { content: [{ type: 'text', text: 'work' }] });
      frame(fake, 'new-1', 'turn/start', { turn: 2 });
      fake.dropOnce();
    },
  });
  const originalRequest = client.request;
  client.request = async (method, params) => {
    if (method === 'session.open') {
      opens += 1;
      const records = reconnected ? oldHistory : oldHistory;
      client.emit('frame', {
        sessionId: params.sessionId,
        frame: {
          type: 'snapshot',
          header: { id: params.sessionId, cwd: '/work' },
          cursor: 10,
          records,
          hasMore: false,
          projections: { values: {} },
        },
      });
      return { sessionId: params.sessionId };
    }
    return originalRequest(method, params);
  };
  client.reconnect = async () => {
    reconnected = true;
    setTimeout(() => {
      assistant(client, 'new-1', 'fresh answer');
      finish(client, 'new-1');
    }, 20);
  };
  const result = await runExec(client, {
    prompt: 'work',
    ssh: 'host',
    reconnect: client.reconnect,
    reconnectWindowMs: 5_000,
  });
  assert.equal(opens, 2);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'fresh answer');
  assert.notEqual(result.text, 'old answer');
});
