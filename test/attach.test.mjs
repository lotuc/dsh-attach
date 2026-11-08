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
    async events(request) {
      calls.push(['events', request]);
      if (typeof state.historyPage === 'function') return state.historyPage(request);
      return { cursor: request.beforeSeq - 1, records: [], hasMore: false };
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
    async fork(request) {
      calls.push(['fork', request]);
      return { sessionId: 'fork-1' };
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
  const state = {
    webLive: false,
    subagentListCalls: 0,
    subagentChildrenCalls: 0,
    subagentPromptCalls: [],
    subagentPromptError: null,
    subagentSendCalls: [],
    subagentInterruptCalls: [],
    directChildren: null,
    historyPage: null,
    subagentRows: null,
    liveAgents: new Set(),
    goal: { id: 'g1', revision: 1, objective: 'Finish', phase: 'active', activation: 'disarmed', maxGoalRounds: 10 },
    goalCompleteCalls: [],
    shellRequests: [],
    skills: [
      { name: 'clojure-eval', description: 'Evaluate Clojure', invocation: { modelInvocable: true, userInvocable: true }, provider: 'filesystem', source: 'user', content: 'REPL instructions' },
      { name: 'user-only', description: 'User only', invocation: { modelInvocable: false, userInvocable: true }, provider: 'filesystem', source: 'user', content: 'user only body' },
      { name: 'model-only', description: 'Model only', invocation: { modelInvocable: true, userInvocable: false }, provider: 'filesystem', source: 'user', content: 'model only body' },
    ],
  };
  const goals = {
    get: () => state.goal,
    complete(agent, ref) {
      state.goalCompleteCalls.push({ agent, ref });
      const goal = { ...state.goal, revision: ref.revision + 1, phase: 'complete', activation: 'disarmed' };
      state.goal = goal;
      return goal;
    },
  };
  const shell = {
    resolve(request) {
      state.shellRequests.push(request);
      return request;
    },
  };
  const workspaceCalls = [];
  const presetRows = [
    { id: 'standard', name: 'Standard mode', description: 'General work', isDefault: true },
    { id: 'minimal', description: 'Minimal mode', isDefault: false },
    { id: 'broken', name: 'Broken', isDefault: false, broken: 'missing service' },
  ];
  const workspaceController = {
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
    async archiveSession(request) {
      workspaceCalls.push(['archiveSession', request]);
      return { archivedSessionIds: [request.sessionId] };
    },
    async unarchiveSession(request) {
      workspaceCalls.push(['unarchiveSession', request]);
      return { archivedSessionIds: [] };
    },
    async pinSession(request) {
      workspaceCalls.push(['pinSession', request]);
      return { pinnedSessionIds: [request.sessionId] };
    },
    async unpinSession(request) {
      workspaceCalls.push(['unpinSession', request]);
      return { pinnedSessionIds: [] };
    },
  };
  const agentPresets = {
    get defaultId() {
      return 'standard';
    },
    async remoteExportList() {
      return { presets: presetRows };
    },
  };
  const subagentRuntime = {
    async listChildren() {
      state.subagentChildrenCalls += 1;
      return state.directChildren ?? [{ id: 'child-1', mode: 'continuable', label: 'Reviewer', createdAt: 1 }];
    },
    async listDescendants() {
      state.subagentListCalls += 1;
      return state.subagentRows ?? [
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
    async prompt(request) {
      state.subagentPromptCalls.push(request);
      if (state.subagentPromptError !== null) throw state.subagentPromptError;
      return { messageId: 'message-1' };
    },
    sendMessage(sender, targetId, content) {
      state.subagentSendCalls.push({ sender, targetId, content });
      return 'message-legacy';
    },
    interruptByParent(childId, parentId, mode) {
      state.subagentInterruptCalls.push({ childId, parentId, mode });
      return { accepted: true };
    },
  };
  const ctx = {
    sessionController: controller,
    logger: { debug() {}, warn() {} },
    get(name) {
      if (name === 'agents') {
        return {
          get: (id) => (id === 's1' ? agent : (state.liveAgents.has(id) ? { id, session: { id } } : undefined)),
        };
      }
      if (name === 'commands') return commands;
      if (name === 'subagents') return subagentRuntime;
      if (name === 'workspaceController') return workspaceController;
      if (name === 'agentPresets') return agentPresets;
      if (name === 'goals') return goals;
      if (name === 'shell') return shell;
      if (name === 'skills') return {
        snapshot: async () => ({ skills: state.skills, complete: true }),
        list: async () => state.skills,
        get: async (skillName) => state.skills.find((skill) => skill.name === skillName),
      };
      if (name === 'typertGateway') return { hasLiveClient: () => state.webLive };
      return undefined;
    },
    on(name, fn) {
      listeners.set(name, fn);
      return () => listeners.delete(name);
    },
  };

  return { ctx, listeners, calls, push, agent, commands, executions, state, workspaceCalls, presetRows, workspaceController, agentPresets };
}

async function makeServerWithFixture(home, fixture, overrides = {}) {
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

async function makeServer(home, overrides = {}) {
  return makeServerWithFixture(home, createFixture(home), overrides);
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

test('forks, archives and pins sessions through optional Host services', async () => {
  await withHost(async ({ client, calls, workspaceCalls }) => {
    const described = await client.request('host.describe');
    for (const capability of ['session.fork', 'session.archive', 'session.pin', 'session.presets']) {
      assert.ok(described.host.capabilities.includes(capability), capability);
    }

    const created = await client.request('session.create', { cwd: '/tmp/work', agentPreset: 'minimal' });
    assert.deepEqual(created, { sessionId: 's2' });
    assert.deepEqual(calls.find((call) => call[0] === 'create')[1], { cwd: '/tmp/work', agentPreset: 'minimal' });

    const forked = await client.request('session.fork', { sessionId: 's1', atSeq: 4 });
    assert.deepEqual(forked, { sessionId: 'fork-1' });
    assert.deepEqual(calls.find((call) => call[0] === 'fork')[1], { sessionId: 's1', atSeq: 4 });

    const archived = await client.request('session.archive', { sessionId: 's1', stopActivity: true });
    assert.deepEqual(archived, { archivedSessionIds: ['s1'] });
    assert.deepEqual(workspaceCalls.find((call) => call[0] === 'archiveSession')[1], {
      sessionId: 's1',
      stopActivity: true,
    });

    assert.deepEqual(await client.request('session.unarchive', { sessionId: 's1' }), { archivedSessionIds: [] });
    assert.deepEqual(await client.request('session.pin', { sessionId: 's1' }), { pinnedSessionIds: ['s1'] });
    assert.deepEqual(await client.request('session.unpin', { sessionId: 's1' }), { pinnedSessionIds: [] });
    assert.deepEqual(workspaceCalls.map((call) => call[0]), [
      'archiveSession',
      'unarchiveSession',
      'pinSession',
      'unpinSession',
    ]);

    const presets = await client.request('session.presets');
    assert.equal(presets.supported, true);
    assert.equal(presets.defaultId, 'standard');
    assert.deepEqual(presets.presets, [
      { id: 'standard', name: 'Standard mode', description: 'General work', isDefault: true },
      { id: 'minimal', name: null, description: 'Minimal mode', isDefault: false },
      { id: 'broken', name: 'Broken', description: null, isDefault: false, broken: 'missing service' },
    ]);
  });
});

test('rejects invalid fork boundaries', async () => {
  await withHost(async ({ client }) => {
    await assert.rejects(
      client.request('session.fork', { sessionId: 's1', atSeq: -1 }),
      (error) => error.code === 'attach/bad-request',
    );
  });
});

test('degrades gracefully when optional lifecycle services are absent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const fixture = createFixture(home);
  const originalGet = fixture.ctx.get.bind(fixture.ctx);
  fixture.ctx.get = (name) => (
    name === 'workspaceController' || name === 'agentPresets' ? undefined : originalGet(name)
  );
  const host = await makeServerWithFixture(home, fixture);
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    assert.equal(client.host.capabilities.includes('session.archive'), false);
    assert.equal(client.host.capabilities.includes('session.pin'), false);
    assert.equal(client.host.capabilities.includes('session.presets'), false);
    assert.deepEqual(await client.request('session.presets'), { supported: false, presets: [] });
    await assert.rejects(
      client.request('session.archive', { sessionId: 's1' }),
      (error) => error.code === 'session/archive-unavailable',
    );
    await assert.rejects(
      client.request('session.pin', { sessionId: 's1' }),
      (error) => error.code === 'session/pin-unavailable',
    );
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
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

test('advertises goal completion only when the goal service supports it', () => {
  const base = {
    sessionController: {},
    get(name) {
      if (name === 'goals') return undefined;
      return undefined;
    },
  };
  const without = new AttachServer(base, {});
  assert.equal(without.hostInfo.capabilities.includes('goal.complete'), false);

  const complete = () => ({});
  const withService = new AttachServer({
    ...base,
    get(name) {
      if (name === 'goals') return { get: () => undefined, complete };
      return undefined;
    },
  }, {});
  assert.equal(withService.hostInfo.capabilities.includes('goal.complete'), true);
});

test('serves goal activation and broadcasts activation changes', async () => {
  await withHost(async ({ client, listeners, state }) => {
    await client.request('session.open', { sessionId: 's1' });
    const value = await client.request('goal.get');
    assert.equal(value.supported, true);
    assert.equal(value.goal.activation, 'disarmed');

    const seen = once(client, 'goal');
    listeners.get('goal/activation-changed')({
      sessionId: 's1',
      goal: { id: 'g1', revision: 1, activation: 'armed' },
    });
    const [message] = await seen;
    assert.equal(message.sessionId, 's1');
    assert.equal(message.goal.activation, 'armed');
    state.goal = { ...state.goal, activation: 'armed' };
  });
});

test('completes the current goal through the goal service', async () => {
  await withHost(async ({ client, state }) => {
    assert.ok(client.host.capabilities.includes('goal.complete'));
    await client.request('session.open', { sessionId: 's1' });
    const value = await client.request('goal.complete');
    assert.equal(value.completed, true);
    assert.equal(value.goal.phase, 'complete');
    assert.equal(value.goal.activation, 'disarmed');
    assert.equal(value.goal.revision, 2);
    assert.deepEqual(state.goalCompleteCalls.map((call) => call.ref), [{ id: 'g1', revision: 1 }]);
    assert.equal(state.goalCompleteCalls[0].agent.id, 's1');
  });
});

test('rejects goal completion when no goal is current', async () => {
  await withHost(async ({ client, state }) => {
    await client.request('session.open', { sessionId: 's1' });
    state.goal = null;
    await assert.rejects(client.request('goal.complete'), (error) => {
      assert.equal(error.code, 'goal/not-found');
      assert.match(error.message, /no goal is currently set/u);
      return true;
    });
    assert.deepEqual(state.goalCompleteCalls, []);
  });
});

test('injects Herdr facts into shell requests for the followed session', async () => {
  await withHost(async ({ client, ctx, state }) => {
    await client.request('session.open', {
      sessionId: 's1',
      env: {
        HERDR_ENV: '1',
        HERDR_PANE_ID: 'w1:p1',
        HERDR_BIN_PATH: '/bin/herdr',
        PATH: '/client/bin',
        ignored: 'no',
      },
    });
    const resolved = await ctx.get('shell').resolve({
      command: 'pwd',
      env: { BASE: '1' },
      dshEnv: { DSH_SESSION_ID: 's1' },
    });
    assert.equal(resolved.env.HERDR_ENV, '1');
    assert.equal(resolved.env.HERDR_PANE_ID, 'w1:p1');
    assert.equal(resolved.env.HERDR_BIN_PATH, '/bin/herdr');
    assert.equal(resolved.env.PATH, undefined, 'only HERDR_* names are accepted');
    assert.equal(resolved.env.BASE, '1');
    assert.equal(state.shellRequests.length, 1);
  });
});

test('lists and loads user-invocable skills for the followed session', async () => {
  await withHost(async ({ client }) => {
    await client.request('session.open', { sessionId: 's1' });
    const list = await client.request('skill.list');
    assert.equal(list.supported, true);
    assert.equal(list.complete, true);
    assert.deepEqual(list.skills.map((skill) => skill.name), ['clojure-eval', 'user-only']);
    assert.equal(list.skills.find((skill) => skill.name === 'clojure-eval').modelInvocable, true);

    const loaded = await client.request('skill.get', { name: 'clojure-eval' });
    assert.equal(loaded.supported, true);
    assert.equal(loaded.skill.content, 'REPL instructions');
    assert.equal(loaded.skill.provider, 'filesystem');

    const hidden = await client.request('skill.get', { name: 'model-only' });
    assert.equal(hidden.supported, true);
    assert.equal(hidden.skill, null);
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
    assert.equal(client.host?.capabilities?.includes('subagent.continue'), true);
    assert.equal(client.host?.capabilities?.includes('subagent.interrupt'), true);
    const value = await client.request('subagent.children', { sessionId: 's1' });
    assert.equal(value.supported, true);
    assert.equal(value.directOnly, false);
    assert.deepEqual(value.control, { continue: true, interrupt: true });
    assert.deepEqual(value.items, [{
      id: 'child-1',
      parentId: 's1',
      depth: 1,
      mode: 'continuable',
      activity: 'running',
      label: 'Reviewer',
      parentActive: true,
      canContinue: true,
      canInterrupt: true,
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
    assert.deepEqual(value.control, { continue: true, interrupt: true });
    assert.equal(value.items.every((item) => item.parentActive === true), true);
    assert.equal(value.items.every((item) => item.canContinue === true), true);
    assert.equal(value.items.every((item) => item.canInterrupt === false), true);
    assert.equal(host.state.subagentListCalls, 0);
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('continues a continuable child through the addressed prompt route', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home);
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await client.request('session.open', { sessionId: 's1' });
    const value = await client.request('subagent.continue', { childId: 'child-1', text: 'keep going' });
    assert.deepEqual(value, { supported: true, accepted: true, messageId: 'message-1' });
    assert.equal(host.state.subagentPromptCalls.length, 1);
    const request = host.state.subagentPromptCalls[0];
    assert.equal(request.parentSessionId, 's1');
    assert.equal(request.childSessionId, 'child-1');
    assert.equal(request.mode, 'continuable');
    assert.equal(request.delivery, 'queue');
    assert.deepEqual(request.content, [{ type: 'text', text: 'keep going' }]);
    assert.equal(typeof request.requestId, 'string');
    assert.equal(typeof request.clientTimeZone, 'string');

    await client.request('subagent.continue', { childId: 'child-1', text: 'now', delivery: 'steer' });
    assert.equal(host.state.subagentPromptCalls.at(-1).delivery, 'steer');

    host.state.subagentPromptError = Object.assign(new Error('inbox closed'), {
      code: 'subagent/delivery-unavailable',
    });
    await assert.rejects(
      client.request('subagent.continue', { childId: 'child-1', text: 'later' }),
      (error) => error.code === 'subagent/delivery-unavailable' && /cannot accept a message/.test(error.message),
    );
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('falls back to the adjacent-Agent sendMessage primitive', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home);
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await client.request('session.open', { sessionId: 's1' });
    const runtime = host.ctx.get('subagents');
    runtime.prompt = undefined;
    const value = await client.request('subagent.continue', { childId: 'child-1', text: 'legacy path' });
    assert.deepEqual(value, { supported: true, accepted: true, messageId: 'message-legacy' });
    assert.equal(host.state.subagentSendCalls.length, 1);
    assert.equal(host.state.subagentSendCalls[0].sender.id, 's1');
    assert.equal(host.state.subagentSendCalls[0].targetId, 'child-1');
    assert.deepEqual(host.state.subagentSendCalls[0].content, [{ type: 'text', text: 'legacy path' }]);
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('rejects continuation of a non-continuable or foreign subagent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home);
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await client.request('session.open', { sessionId: 's1' });
    host.state.subagentRows = [{
      kind: 'child',
      id: 'child-1',
      parentId: 's1',
      depth: 1,
      mode: 'one-shot',
      activity: 'inactive',
      label: 'One shot',
    }];
    await assert.rejects(
      client.request('subagent.continue', { childId: 'child-1', text: 'hello' }),
      (error) => error.code === 'subagent/not-resumable' && /continuable/i.test(error.message),
    );
    await assert.rejects(
      client.request('subagent.continue', { childId: 'other-child', text: 'hello' }),
      (error) => error.code === 'attach/not-found',
    );
    await assert.rejects(
      client.request('subagent.continue', { childId: 'child-1', text: '  ' }),
      (error) => error.code === 'attach/bad-request',
    );
    await assert.rejects(
      client.request('subagent.interrupt', { childId: 'other-child' }),
      (error) => error.code === 'attach/not-found',
    );
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('reports a missing parent for continuation and accepts interrupt', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home);
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await client.request('session.open', { sessionId: 's1' });
    host.state.subagentRows = [{
      kind: 'child',
      id: 'child-1',
      parentId: 'offline-parent',
      depth: 1,
      mode: 'continuable',
      activity: 'running',
      label: 'Reviewer',
    }];
    await assert.rejects(
      client.request('subagent.continue', { childId: 'child-1', text: 'hello' }),
      (error) => error.code === 'subagent/parent-unavailable',
    );

    const stopped = await client.request('subagent.interrupt', { childId: 'child-1' });
    assert.deepEqual(stopped, { supported: true, accepted: true });
    assert.deepEqual(host.state.subagentInterruptCalls, [{
      childId: 'child-1',
      parentId: 'offline-parent',
      mode: 'continuable',
    }]);
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('interrupts the currently viewed subagent with its durable parent address', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home);
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await client.request('session.open', { sessionId: 'child-1', parentSessionId: 's1', mode: 'continuable' });
    const value = await client.request('subagent.interrupt', {
      childId: 'child-1',
      parentSessionId: 's1',
    });
    assert.deepEqual(value, { supported: true, accepted: true });
    assert.deepEqual(host.state.subagentInterruptCalls, [{
      childId: 'child-1',
      parentId: 's1',
      mode: 'continuable',
    }]);
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('reports unsupported subagent control when the runtime lacks the methods', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home);
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await client.request('session.open', { sessionId: 's1' });
    const runtime = host.ctx.get('subagents');
    runtime.prompt = undefined;
    runtime.sendMessage = undefined;
    runtime.interruptByParent = undefined;
    runtime.interrupt = undefined;

    const described = await client.request('host.describe');
    assert.equal(described.host.capabilities.includes('subagent.continue'), false);
    assert.equal(described.host.capabilities.includes('subagent.interrupt'), false);
    const continued = await client.request('subagent.continue', { childId: 'child-1', text: 'hello' });
    assert.equal(continued.supported, false);
    assert.match(continued.reason, /continuation/i);
    const stopped = await client.request('subagent.interrupt', { childId: 'child-1' });
    assert.equal(stopped.supported, false);
    assert.match(stopped.reason, /interruption/i);
    const children = await client.request('subagent.children', { sessionId: 's1' });
    assert.deepEqual(children.control, { continue: false, interrupt: false });
    assert.equal(children.items[0].canContinue, false);
    assert.equal(children.items[0].canInterrupt, false);
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

test('serves an older history page keyed by beforeSeq', async () => {
  await withHost(async ({ client, calls, state }) => {
    state.historyPage = () => ({
      cursor: 20,
      hasMore: true,
      records: [
        { type: 'event', event: { type: 'user/message', seq: 5, data: { content: [{ type: 'text', text: 'five' }], source: { kind: 'user' } } } },
        { type: 'event', event: { type: 'assistant/message', seq: 6, data: { message: { content: [{ type: 'text', text: 'six' }] } } } },
      ],
    });
    await client.request('session.open', { sessionId: 's1' });
    const page = await client.request('history.events', { beforeSeq: 10 });
    const call = calls.find((entry) => entry[0] === 'events');
    assert.deepEqual(call[1], {
      address: { kind: 'session', sessionId: 's1' },
      beforeSeq: 10,
      maxMessages: 300,
    });
    assert.deepEqual(page.records.map((record) => record.event.seq), [5, 6]);
    assert.equal(page.hasMore, true);
    assert.equal(page.cursor, 20);
    assert.equal(page.oldestSeq, 5);
    assert.equal(page.newestSeq, 6);
    assert.equal(page.beforeSeq, 10);

    const described = await client.request('host.describe');
    assert.ok(described.host.capabilities.includes('history.pagination'));
  });
});

test('uses the durable subagent address for older history', async () => {
  await withHost(async ({ client, calls }) => {
    await client.request('session.open', { sessionId: 'child', parentSessionId: 'parent', mode: 'continuable' });
    await client.request('history.events', { beforeSeq: 8 });
    const call = calls.find((entry) => entry[0] === 'events');
    assert.deepEqual(call[1].address, {
      kind: 'subagent',
      parentSessionId: 'parent',
      childSessionId: 'child',
      mode: 'continuable',
    });
  });
});

test('rejects malformed history cursors and sessions without one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home);
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await assert.rejects(
      () => client.request('history.events', { beforeSeq: 1 }),
      /no session is open/,
    );
    await client.request('session.open', { sessionId: 's1' });
    for (const beforeSeq of [undefined, -1, 1.5, '3', null]) {
      await assert.rejects(
        () => client.request('history.events', { beforeSeq }),
        /beforeSeq must be a non-negative safe integer/,
      );
    }
    assert.equal(host.calls.some((entry) => entry[0] === 'events'), false, 'invalid cursors never reach DSH');
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('falls back to the deprecated page alias for older Host APIs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home);
  const controller = host.ctx.sessionController;
  delete controller.events;
  controller.page = async (request) => ({
    cursor: request.beforeSeq - 1,
    hasMore: false,
    records: [{ type: 'event', event: { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: 'old' }], source: { kind: 'user' } } } }],
  });
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await client.request('session.open', { sessionId: 's1' });
    const described = await client.request('host.describe');
    assert.ok(described.host.capabilities.includes('history.pagination'));
    const page = await client.request('history.events', { beforeSeq: 4 });
    assert.deepEqual(page.records.map((record) => record.event.seq), [3]);
    assert.equal(page.oldestSeq, 3);
  } finally {
    client.close();
    await host.server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('reports hosts without a history pagination API', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-test-'));
  const host = await makeServer(home);
  delete host.ctx.sessionController.events;
  delete host.ctx.sessionController.page;
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await client.request('session.open', { sessionId: 's1' });
    const described = await client.request('host.describe');
    assert.equal(described.host.capabilities.includes('history.pagination'), false);
    await assert.rejects(
      () => client.request('history.events', { beforeSeq: 4 }),
      /does not expose Session history pagination/,
    );
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
