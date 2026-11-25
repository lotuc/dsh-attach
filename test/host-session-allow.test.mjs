import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { expectRouteError, withAttachHost } from './helpers/attach-host.mjs';

const delay = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

const TOOL_CALL = {
  type: 'tool/call',
  data: {
    callId: 'call-1',
    name: 'bash',
    arguments: JSON.stringify({ command: 'npm test', sandbox_permissions: 'workspace-write' }),
  },
};

function approvalRequest(agent, overrides = {}) {
  return {
    agent,
    toolName: 'bash',
    reason: 'run tests',
    displayReason: { en: 'Run tests', zh: '运行测试' },
    callId: 'call-1',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function sessionWithEvents(agent, events) {
  agent.session.snapshotEvents = () => events;
  return agent;
}

test('a mirrored session rule allows a matching call before any panel is broadcast', async () => {
  await withAttachHost(async ({ client, listeners, agent }) => {
    await expectRouteError(
      client.request('approval.allowSession', { rule: { tool: 'bash', commandPrefix: ['npm', 'test'] } }),
      'attach/no-session',
    );
    await client.request('session.open', { sessionId: 's1' });
    await expectRouteError(
      client.request('approval.allowSession', { rule: { tool: 'bash' } }),
      'attach/bad-request',
    );
    await expectRouteError(
      client.request('approval.allowSession', { rule: { tool: 'bash', sandbox: 'root' } }),
      'attach/bad-request',
    );
    const mirrored = await client.request('approval.allowSession', {
      rule: { tool: 'bash', commandPrefix: ['npm', 'test'], sandbox: 'workspace-write' },
    });
    assert.equal(mirrored.accepted, true);
    assert.equal(mirrored.rules, 1);

    sessionWithEvents(agent, [TOOL_CALL]);
    let interactive = 0;
    client.on('interactive', () => { interactive += 1; });
    let delegated = 0;
    const outcome = await listeners.get('approval/request')(approvalRequest(agent), () => {
      delegated += 1;
      return 'delegated';
    });
    assert.equal(outcome, 'allowed-once');
    assert.equal(delegated, 0, 'the Host settles the request without an answerer');
    await delay();
    assert.equal(interactive, 0, 'neither the terminal nor the Web sees a panel');

    // A different command still asks.
    const otherSeen = once(client, 'interactive');
    const other = listeners.get('approval/request')(
      approvalRequest(agent, {
        callId: 'call-2',
        toolName: 'bash',
        agent: sessionWithEvents(agent, [{
          type: 'tool/call',
          data: {
            callId: 'call-2',
            name: 'bash',
            arguments: JSON.stringify({ command: 'npm install', sandbox_permissions: 'workspace-write' }),
          },
        }]),
      }),
      () => 'delegated',
    );
    const [message] = await otherSeen;
    assert.equal(message.type, 'approval');
    await client.request('approval.respond', { requestId: message.requestId, outcome: 'rejected' });
    assert.equal(await other, 'rejected');
  });
});

test('approvals off takes precedence over a mirrored session rule', async () => {
  await withAttachHost(async ({ client, listeners, agent }) => {
    await client.request('session.open', { sessionId: 's1' });
    await client.request('approval.allowSession', {
      rule: { tool: 'bash', commandPrefix: ['npm', 'test'], sandbox: 'workspace-write' },
    });
    sessionWithEvents(agent, [TOOL_CALL]);
    let delegated = 0;
    const outcome = await listeners.get('approval/request')(approvalRequest(agent), () => {
      delegated += 1;
      return 'delegated';
    });
    assert.equal(outcome, 'delegated', 'approvals: off ignores mirrored rules');
    assert.equal(delegated, 1);
  }, { config: { approvals: 'off', questions: 'tui' } });
});

test('host-side matching fails closed when arguments or the call id are unavailable', async () => {
  await withAttachHost(async ({ client, listeners, agent }) => {
    await client.request('session.open', { sessionId: 's1' });
    await client.request('approval.allowSession', {
      rule: { tool: 'bash', commandPrefix: ['npm', 'test'], sandbox: 'workspace-write' },
    });

    // Unknown call id: no tool/call event in the log.
    const unknownSeen = once(client, 'interactive');
    const unknown = listeners.get('approval/request')(
      approvalRequest(sessionWithEvents(agent, []), { callId: 'missing' }),
      () => 'delegated',
    );
    const [unknownMessage] = await unknownSeen;
    await client.request('approval.cancel', { requestId: unknownMessage.requestId });
    assert.equal(await unknown, 'delegated');

    // Missing call id: no lookup is attempted.
    const noCallSeen = once(client, 'interactive');
    const noCall = listeners.get('approval/request')(
      approvalRequest(agent, { callId: undefined }),
      () => 'delegated',
    );
    const [noCallMessage] = await noCallSeen;
    await client.request('approval.cancel', { requestId: noCallMessage.requestId });
    assert.equal(await noCall, 'delegated');

    // Unparseable arguments: fail closed rather than matching a prefix.
    const badSeen = once(client, 'interactive');
    const bad = listeners.get('approval/request')(
      approvalRequest(sessionWithEvents(agent, [{
        type: 'tool/call',
        data: { callId: 'call-1', name: 'bash', arguments: '{not json' },
      }])),
      () => 'delegated',
    );
    const [badMessage] = await badSeen;
    await client.request('approval.cancel', { requestId: badMessage.requestId });
    assert.equal(await bad, 'delegated');

    // A Session without a readable log cannot prove the arguments.
    const coldSeen = once(client, 'interactive');
    const cold = listeners.get('approval/request')(
      approvalRequest({ id: 's1', session: { id: 's1', header: { cwd: '/work' } } }),
      () => 'delegated',
    );
    const [coldMessage] = await coldSeen;
    await client.request('approval.cancel', { requestId: coldMessage.requestId });
    assert.equal(await cold, 'delegated');
  });
});

test('session rules are connection-owned and cleared when the session closes', async () => {
  await withAttachHost(async ({ client, listeners, agent }) => {
    await client.request('session.open', { sessionId: 's1' });
    await client.request('approval.allowSession', {
      rule: { tool: 'bash', commandPrefix: ['npm', 'test'], sandbox: 'workspace-write' },
    });
    await client.request('session.close');

    await client.request('session.open', { sessionId: 's1' });
    sessionWithEvents(agent, [TOOL_CALL]);
    const seen = once(client, 'interactive');
    const pending = listeners.get('approval/request')(approvalRequest(agent), () => 'delegated');
    const [message] = await seen;
    assert.equal(message.type, 'approval');
    await client.request('approval.cancel', { requestId: message.requestId });
    assert.equal(await pending, 'delegated');
  });
});

test('a mirrored danger-full-access rule requires the explicit marker and sandbox', async () => {
  await withAttachHost(async ({ client, listeners, agent }) => {
    await client.request('session.open', { sessionId: 's1' });
    await client.request('approval.allowSession', {
      rule: { tool: 'bash', commandPrefix: ['rm'] },
    });
    const dangerEvents = [{
      type: 'tool/call',
      data: {
        callId: 'call-1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'rm -rf build', sandbox_permissions: 'danger-full-access' }),
      },
    }];
    sessionWithEvents(agent, dangerEvents);
    const deniedSeen = once(client, 'interactive');
    const denied = listeners.get('approval/request')(approvalRequest(agent), () => 'delegated');
    const [deniedMessage] = await deniedSeen;
    await client.request('approval.cancel', { requestId: deniedMessage.requestId });
    assert.equal(await denied, 'delegated');

    await client.request('approval.allowSession', {
      rule: { tool: 'bash', commandPrefix: ['rm'], sandbox: 'danger-full-access' },
    });
    const allowed = await listeners.get('approval/request')(approvalRequest(agent), () => 'delegated');
    assert.equal(allowed, 'allowed-once');
  });
});
