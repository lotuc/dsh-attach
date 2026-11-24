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
    (error) => error?.code === 'attach/follow' && /follow failed/.test(error.message),
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
    (error) => error?.code === 'attach/closed',
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
