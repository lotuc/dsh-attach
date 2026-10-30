import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AttachClient } from '../lib/client/connection.js';
import { AttachServer } from '../lib/host/server.js';

const snapshot = {
  type: 'snapshot',
  header: { version: 4, id: 's1', createdAt: Date.now(), cwd: '/tmp/work', isSeeded: false, agentPreset: 'standard' },
  cursor: 1,
  records: [
    { type: 'event', event: { type: 'session/title', seq: 0, time: Date.now(), data: { title: 'Fixture' } } },
  ],
  hasMore: false,
  projections: { asOfSeq: 1, values: { title: 'Fixture', modelSelection: { lastUsed: { provider: 'p', model: 'm' } } } },
};

function createFixture(home) {
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE = 'test';
  const listeners = new Map();
  const calls = [];
  let queue = [];
  let wake;
  let running = false;

  const push = (item) => {
    queue.push(item);
    wake?.();
    wake = undefined;
  };

  const controller = {
    async list() {
      return {
        items: [
          {
            sessionId: 's1',
            updatedAt: Date.now(),
            running,
            blank: false,
            cwd: '/tmp/work',
            agentAvailable: true,
            projections: { kind: 'sequenced', ...snapshot.projections },
          },
        ],
      };
    },
    follow(request) {
      calls.push(['follow', request]);
      return (async function* follow() {
        yield snapshot;
        while (true) {
          if (queue.length === 0) await new Promise((resolve) => { wake = resolve; });
          const item = queue.shift();
          if (item === undefined) continue;
          if (item === '__end__') return;
          yield item;
        }
      })();
    },
    async prompt(request) {
      calls.push(['prompt', request]);
      return { accepted: true };
    },
    cancel(request) {
      calls.push(['cancel', request]);
      return { accepted: true };
    },
    async updateQueue(request) {
      calls.push(['updateQueue', request]);
      return { accepted: true };
    },
    async create(request) {
      calls.push(['create', request]);
      return { sessionId: 's2' };
    },
    async rename(request) {
      calls.push(['rename', request]);
      return { title: request.title };
    },
    async modelCatalog() {
      return { default: { provider: 'p', model: 'm' }, routableProviders: ['p'], groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }], failures: [] };
    },
    async selectModel(request) {
      calls.push(['selectModel', request]);
      return { selected: { provider: request.provider, model: request.model } };
    },
  };

  const agent = { id: 's1', session: { id: 's1', header: { cwd: '/tmp/work' } } };
  const executions = [];
  const commands = {
    list() {
      return [
        { name: 'compact', description: 'Compact context', input: { hint: '' } },
        { name: 'plan', description: 'Enter plan mode', input: { hint: '<message>' } },
      ];
    },
    async execute(target, line) {
      executions.push({ target, line });
      return { commandId: 'cmd-1', result: { kind: 'success', text: `ran ${line}` } };
    },
  };
  const state = { webLive: false, subagentListCalls: 0, subagentChildrenCalls: 0, directChildren: null };
  const ctx = {
    sessionController: controller,
    logger: { debug() {}, warn() {} },
    get(name) {
      if (name === 'agents') return { get: (id) => (id === 's1' ? agent : undefined) };
      if (name === 'commands') return commands;
      if (name === 'subagents') {
        return {
          async listChildren() {
            state.subagentChildrenCalls += 1;
            return state.directChildren ?? [{ id: 'child-1', mode: 'continuable', label: 'Reviewer', createdAt: 1 }];
          },
          async listDescendants() {
            state.subagentListCalls += 1;
            return [
              {
                kind: 'child',
                id: 'child-1',
                parentId: 's1',
                depth: 1,
                mode: 'continuable',
                activity: 'running',
                label: 'Reviewer',
              },
            ];
          },
        };
      }
      if (name === 'workspaceController') {
        return {
          async *follow() {
            yield {
              type: 'baseline',
              value: {
                items: [{ workspaceId: 'w1', title: 'Work', path: '/work', sessionIds: ['s1'] }],
                archivedSessionIds: [],
                pinnedSessionIds: [],
              },
            };
          },
        };
      }
      if (name === 'typertGateway') return { hasLiveClient: () => state.webLive };
      return undefined;
    },
    on(name, fn) {
      listeners.set(name, fn);
      return () => listeners.delete(name);
    },
  };

  return { ctx, listeners, calls, push, agent, commands, executions, state };
}

async function makeServer(home, overrides = {}) {
  const fixture = createFixture(home);
  const server = new AttachServer(fixture.ctx, {
    enabled: true,
    socketPath: '',
    approvals: 'auto',
    questions: 'auto',
    activeWindowMinutes: 10,
    approvalGraceSeconds: 20,
    questionGraceSeconds: 20,
    ...overrides,
  });
  await server.start();
  const descriptor = JSON.parse(await readFile(join(home, 'tui-attach', 'endpoint.json'), 'utf8'));
  return { ...fixture, server, descriptor };
}

async function withHost(fn) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home);
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await fn({ ...host, client });
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
}

test('lists, opens, streams and prompts a session', async () => {
  await withHost(async ({ client, calls, push }) => {
    const list = await client.request('session.list');
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].title, 'Fixture');

    const frames = [];
    client.on('frame', (message) => frames.push(message.frame));
    const opened = await client.request('session.open', { sessionId: 's1' });
    assert.equal(opened.sessionId, 's1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(frames[0].type, 'snapshot');

    push({ type: 'event', event: { type: 'user/message', seq: 2, time: Date.now(), data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(frames.at(-1).type, 'event');

    const prompt = await client.request('session.prompt', { text: 'hello', mode: 'queue' });
    assert.equal(prompt.accepted, true);
    const recorded = calls.find((call) => call[0] === 'prompt')[1];
    assert.equal(recorded.sessionId, 's1');
    assert.deepEqual(recorded.content, [{ type: 'text', text: 'hello' }]);

    const imagePrompt = await client.request('session.prompt', {
      text: '',
      mode: 'queue',
      images: [{ mediaType: 'image/png', data: 'YWJj', name: 'clipboard.png' }],
    });
    assert.equal(imagePrompt.accepted, true);
    const imageRecorded = calls.filter((call) => call[0] === 'prompt').at(-1)[1];
    assert.deepEqual(imageRecorded.content, [
      { type: 'image', mediaType: 'image/png', data: 'YWJj', name: 'clipboard.png' },
    ]);

    await client.request('session.prompt', { text: 'continue', mode: 'queue', requestId: 'attach-resume-s1-2' });
    assert.equal(calls.filter((call) => call[0] === 'prompt').at(-1)[1].requestId, 'attach-resume-s1-2');

    const queueUpdate = await client.request('queue.update', {
      itemId: 'message-1',
      action: { kind: 'remove' },
    });
    assert.deepEqual(queueUpdate, { accepted: true });
    assert.deepEqual(calls.find((call) => call[0] === 'updateQueue')[1], {
      sessionId: 's1',
      itemId: 'message-1',
      action: { kind: 'remove' },
    });

    const summary = await client.request('subagent.summary', { sessionId: 's1' });
    assert.equal(summary.supported, true);
    assert.equal(summary.total, 0);

    const workspaces = await client.request('workspace.list');
    assert.equal(workspaces.items.length, 1);
    assert.equal(workspaces.items[0].title, 'Work');
    assert.deepEqual(workspaces.items[0].sessionIds, ['s1']);

    const listed = await client.request('commands.list');
    assert.deepEqual(listed.commands.map((command) => command.name), ['compact', 'plan']);
    assert.equal(listed.commands[1].argumentHint, '<message>');

    const executed = await client.request('commands.execute', { line: '/compact' });
    assert.equal(executed.executed, true);
    assert.equal(executed.result.text, 'ran /compact');
  });
});

test('reconnects the same client to a restarted Host', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  let host = await makeServer(home);
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    const firstPid = client.host?.pid;
    assert.equal(typeof firstPid, 'number');
    let closes = 0;
    client.on('close', () => { closes += 1; });

    await host.server.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closes, 1);

    host = await makeServer(home);
    await client.reconnect({ timeoutMs: 2000 });
    assert.equal(typeof client.host?.pid, 'number');
    assert.equal(closes, 1, 'replacing the socket must not emit another close');
    const list = await client.request('session.list');
    assert.equal(list.items[0].sessionId, 's1');
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('adds short catalog labels to active subagents', async () => {
  await withHost(async ({ client, ctx, state }) => {
    ctx.sessionController.list = async () => ({
      items: [
        { sessionId: 's1', running: true, projections: { values: { title: 'Root' } } },
        {
          sessionId: 'child-1',
          parentSessionId: 's1',
          origin: 'subagent',
          running: true,
          projections: { values: { title: 'Long task prompt that should not label the peek' } },
        },
      ],
    });
    const summary = await client.request('subagent.summary', { sessionId: 's1' });
    assert.equal(summary.active.length, 1);
    assert.equal(summary.active[0].label, 'Reviewer');
    assert.equal(summary.active[0].title, 'Long task prompt that should not label the peek');

    const cached = await client.request('subagent.summary', { sessionId: 's1' });
    assert.equal(cached.active[0].label, 'Reviewer');
    assert.equal(state.subagentChildrenCalls, 1);
  });
});

test('routes approvals and questions to the terminal', async () => {
  await withHost(async ({ client, listeners }) => {
    await client.request('session.open', { sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const approvalSeen = once(client, 'interactive');
    let delegated = 0;
    const approval = listeners.get('approval/request')({
      agent: { session: { id: 's1' } },
      toolName: 'bash',
      reason: 'install',
      signal: new AbortController().signal,
    }, () => { delegated += 1; return 'unavailable'; });
    const [approvalMessage] = await approvalSeen;
    assert.equal(approvalMessage.type, 'approval');
    assert.equal(approvalMessage.toolName, 'bash');
    await client.request('approval.respond', { requestId: approvalMessage.requestId, outcome: 'allowed-once' });
    assert.equal(await approval, 'allowed-once');
    assert.equal(delegated, 0);

    const questionSeen = once(client, 'interactive');
    const question = listeners.get('user-questions/request')({
      agent: { session: { id: 's1' } },
      questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'yes' }, { label: 'no' }] }],
      signal: new AbortController().signal,
    }, () => 'unavailable');
    const [questionMessage] = await questionSeen;
    assert.equal(questionMessage.type, 'question');
    await client.request('question.respond', { requestId: questionMessage.requestId, answers: [{ id: 'q', selected: ['yes'] }] });
    assert.deepEqual(await question, { answers: [{ id: 'q', selected: ['yes'] }] });

    const cancelSeen = once(client, 'interactive');
    const cancelled = listeners.get('user-questions/request')({
      agent: { session: { id: 's1' } },
      questions: [{ id: 'q2', question: 'Cancel me?' }],
      signal: new AbortController().signal,
    }, () => 'delegated');
    const [cancelMessage] = await cancelSeen;
    await client.request('question.cancel', { requestId: cancelMessage.requestId });
    assert.equal(await cancelled, 'delegated');
  });
});

test('broadcasts approvals to every terminal watching the session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home, { approvals: 'tui', questions: 'tui' });
  const first = new AttachClient();
  const second = new AttachClient();
  try {
    await first.connect({ timeoutMs: 2000 });
    await second.connect({ timeoutMs: 2000 });
    await first.request('session.open', { sessionId: 's1' });
    await second.request('session.open', { sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const firstSeen = once(first, 'interactive');
    const secondSeen = once(second, 'interactive');
    const secondClosed = once(second, 'interactive-closed');
    const outcome = host.listeners.get('approval/request')({
      agent: { session: { id: 's1' } },
      toolName: 'bash',
      reason: 'two windows',
      signal: new AbortController().signal,
    }, () => 'unavailable');
    const [[firstMessage], [secondMessage]] = await Promise.all([firstSeen, secondSeen]);
    assert.equal(firstMessage.type, 'approval');
    assert.equal(secondMessage.type, 'approval');
    await first.request('approval.respond', { requestId: firstMessage.requestId, outcome: 'allowed-once' });
    assert.equal(await outcome, 'allowed-once');
    const [closed] = await secondClosed;
    assert.equal(closed.requestId, secondMessage.requestId);
  } finally {
    first.close();
    second.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('replays a pending approval to a terminal that attaches later', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home, { approvals: 'tui' });
  const client = new AttachClient();
  try {
    const outcome = host.listeners.get('approval/request')({
      agent: { session: { id: 's1' } },
      toolName: 'bash',
      reason: 'attached late',
      signal: new AbortController().signal,
    }, () => 'unavailable');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.connect({ timeoutMs: 2000 });
    const seen = once(client, 'interactive');
    await client.request('session.open', { sessionId: 's1' });
    const [message] = await seen;
    assert.equal(message.type, 'approval');
    assert.equal(message.reason, 'attached late');
    await client.request('approval.respond', { requestId: message.requestId, outcome: 'allowed-once' });
    assert.equal(await outcome, 'allowed-once');
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('replays a pending approval while the Web answerer is still waiting', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home, { approvals: 'tui' });
  host.state.webLive = true;
  const client = new AttachClient();
  try {
    const outcome = host.listeners.get('approval/request')({
      agent: { session: { id: 's1' } },
      toolName: 'bash',
      reason: 'web is waiting',
      signal: new AbortController().signal,
    }, () => new Promise(() => {}));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.connect({ timeoutMs: 2000 });
    const seen = once(client, 'interactive');
    await client.request('session.open', { sessionId: 's1' });
    const [message] = await seen;
    assert.equal(message.type, 'approval');
    await client.request('approval.respond', { requestId: message.requestId, outcome: 'rejected' });
    assert.equal(await outcome, 'rejected');
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('tui approval mode still answers when a Web client is live', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home, { approvals: 'tui', questions: 'tui' });
  host.state.webLive = true;
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await client.request('session.open', { sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const seen = once(client, 'interactive');
    const outcome = host.listeners.get('approval/request')({
      agent: { session: { id: 's1' } },
      toolName: 'bash',
      reason: 'write outside the workspace',
      signal: new AbortController().signal,
    }, () => 'unavailable');
    const [message] = await seen;
    assert.equal(message.type, 'approval');
    await client.request('approval.respond', { requestId: message.requestId, outcome: 'rejected' });
    assert.equal(await outcome, 'rejected');
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('does not start the Web answerer while a terminal is watching', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home, { approvals: 'tui', approvalGraceSeconds: 0.01 });
  host.state.webLive = true;
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await client.request('session.open', { sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const seen = once(client, 'interactive');
    let delegated = 0;
    const outcome = host.listeners.get('approval/request')({
      agent: { session: { id: 's1' } },
      toolName: 'bash',
      reason: 'terminal owns this',
      signal: new AbortController().signal,
    }, () => { delegated += 1; return 'unavailable'; });
    const [message] = await seen;
    await client.request('interactive.ack', { requestId: message.requestId });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(delegated, 0);
    await client.request('approval.respond', { requestId: message.requestId, outcome: 'allowed-once' });
    assert.equal(await outcome, 'allowed-once');
    assert.equal(delegated, 0);
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('hands an unacknowledged terminal approval to Web after grace', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home, { approvals: 'tui', approvalGraceSeconds: 0.01 });
  host.state.webLive = true;
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await client.request('session.open', { sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const seen = once(client, 'interactive');
    let delegated = 0;
    const outcome = host.listeners.get('approval/request')({
      agent: { session: { id: 's1' } },
      toolName: 'bash',
      reason: 'terminal has not shown the panel',
      signal: new AbortController().signal,
    }, () => { delegated += 1; return 'allowed-once'; });
    await seen;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(delegated, 1);
    assert.equal(await outcome, 'allowed-once');
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('hands a pending approval to Web when the terminal disconnects', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home, { approvals: 'tui', approvalGraceSeconds: 0.01 });
  host.state.webLive = true;
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await client.request('session.open', { sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const seen = once(client, 'interactive');
    let delegated = 0;
    const outcome = host.listeners.get('approval/request')({
      agent: { session: { id: 's1' } },
      toolName: 'bash',
      reason: 'terminal leaves',
      signal: new AbortController().signal,
    }, () => { delegated += 1; return 'allowed-once'; });
    const [message] = await seen;
    await client.request('interactive.ack', { requestId: message.requestId });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(delegated, 0);
    client.close();
    assert.equal(await outcome, 'allowed-once');
    assert.equal(delegated, 1);
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('serves the direct-child catalog to the subagent picker', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home);
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    const value = await client.request('subagent.children', { sessionId: 's1' });
    assert.equal(value.supported, true);
    assert.equal(value.directOnly, false);
    assert.deepEqual(value.items, [{
      id: 'child-1',
      parentId: 's1',
      depth: 1,
      mode: 'continuable',
      activity: 'running',
      label: 'Reviewer',
    }]);
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('uses direct children without walking a large catalog', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home);
  const client = new AttachClient();
  try {
    host.state.directChildren = Array.from({ length: 33 }, (_, index) => ({
      id: `child-${index}`,
      mode: 'continuable',
      label: `Child ${index}`,
      createdAt: index,
    }));
    await client.connect({ timeoutMs: 2000 });
    const value = await client.request('subagent.children', { sessionId: 's1' });
    assert.equal(value.supported, true);
    assert.equal(value.directOnly, true);
    assert.equal(value.items.length, 33);
    assert.equal(host.state.subagentListCalls, 0);
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('opens a subagent with its durable parent address', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home);
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await client.request('session.open', { sessionId: 'child', parentSessionId: 'parent', mode: 'unknown' });
    const follow = host.calls.find((call) => call[0] === 'follow');
    assert.deepEqual(follow?.[1]?.address, {
      kind: 'subagent',
      parentSessionId: 'parent',
      childSessionId: 'child',
      mode: 'unknown',
    });
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('honors the configured history snapshot limit', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home, { historyMessages: 600 });
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await client.request('session.open', { sessionId: 's1' });
    const follow = host.calls.find((call) => call[0] === 'follow');
    assert.equal(follow?.[1]?.maxMessages, 600);
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('rejects a bad token and accepts the real one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home);
  try {
    const wrong = new AttachClient();
    await assert.rejects(
      () => wrong.connect({ socketPath: host.descriptor.socketPath, token: 'wrong', timeoutMs: 1200 }),
      /invalid attach token|timed out|closed/i,
    );
    wrong.close();

    const right = new AttachClient();
    await right.connect({ socketPath: host.descriptor.socketPath, token: host.descriptor.token, timeoutMs: 1200 });
    const described = await right.request('host.describe');
    assert.equal(described.host.protocol, 1);
    right.close();
  } finally {
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});
