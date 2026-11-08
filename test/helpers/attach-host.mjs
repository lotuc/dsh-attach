/**
 * Reusable end-to-end fixture for the Host socket routes.
 *
 * The fixture owns a fake DSH `ctx` with just enough services for the bridge,
 * plus a real `AttachServer` listening on a real Unix socket and a real
 * `AttachClient` connected to it. Tests drive the routes exactly as the TUI
 * does, then mutate `fixture.services`/controller methods to aim at optional
 * capabilities and failure branches.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AttachClient } from '../../lib/client/connection.js';
import { AttachServer } from '../../lib/host/server.js';
import { ENDPOINT_DIR, ENDPOINT_FILE } from '../../lib/shared/protocol.js';

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  socketPath: '',
  approvals: 'auto',
  questions: 'auto',
  activeWindowMinutes: 10,
  historyMessages: 300,
  approvalGraceSeconds: 0,
  questionGraceSeconds: 0,
});

function defaultSnapshot() {
  return {
    type: 'snapshot',
    header: {
      version: 4,
      id: 's1',
      createdAt: 0,
      cwd: '/work',
      isSeeded: false,
      agentPreset: 'standard',
    },
    cursor: 1,
    records: [],
    hasMore: false,
    projections: {
      asOfSeq: 1,
      values: {
        title: 'Fixture',
        modelSelection: { lastUsed: { provider: 'p', model: 'm' } },
      },
    },
  };
}

function defaultSessionItems() {
  return [
    {
      sessionId: 's1',
      updatedAt: 100,
      running: true,
      cwd: '/work',
      agentAvailable: true,
      projections: {
        kind: 'sequenced',
        asOfSeq: 1,
        values: {
          title: 'Fixture',
          agentPreset: 'standard',
          modelSelection: { lastUsed: { provider: 'p', model: 'm' } },
        },
      },
    },
    {
      sessionId: 's2',
      updatedAt: 200,
      running: false,
      parentSessionId: 's1',
      origin: 'subagent',
      agentAvailable: false,
      projections: { values: { workingDirectory: '/projects/demo' } },
    },
  ];
}

function defaultSkills() {
  return [
    {
      name: 'clojure-eval',
      description: 'Evaluate Clojure',
      whenToUse: 'When a REPL is running',
      path: '/skills/clojure-eval/SKILL.md',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'filesystem',
      source: 'user',
      content: 'REPL instructions',
    },
    {
      name: 'user-only',
      description: 'User only',
      invocation: { modelInvocable: false, userInvocable: true },
      provider: 'filesystem',
      source: 'user',
      content: 'user only body',
    },
    {
      name: 'model-only',
      description: 'Model only',
      invocation: { modelInvocable: true, userInvocable: false },
      provider: 'filesystem',
      source: 'user',
      content: 'model only body',
    },
  ];
}

function defaultSubagentRows() {
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
    { kind: 'link', id: 'link-1', parentId: 's1', depth: 1 },
  ];
}

function defaultDirectChildren() {
  return [{ id: 'child-1', mode: 'continuable', label: 'Reviewer', createdAt: 1 }];
}

/**
 * Build the fake Host context.
 *
 * @returns {{
 *   ctx: object,
 *   services: Record<string, any>,
 *   state: Record<string, any>,
 *   calls: Array<any[]>,
 *   listeners: Map<string, Function>,
 *   agent: object,
 * }}
 */
export function createHostFixture() {
  const calls = [];
  const listeners = new Map();
  const state = {
    sessionItems: defaultSessionItems(),
    snapshot: defaultSnapshot(),
    historyPage: null,
    followFrames: [],
    followError: null,
    webLive: false,
    goal: {
      id: 'g1',
      revision: 1,
      objective: 'Finish the harness work',
      phase: 'active',
      activation: 'disarmed',
      maxGoalRounds: 10,
    },
    goalGetError: null,
    resolveAgentResult: undefined,
    skills: defaultSkills(),
    subagentRows: defaultSubagentRows(),
    directChildren: defaultDirectChildren(),
    jobs: new Map([
      ['bash-a', { id: 'bash-a', kind: 'bash', label: 'build', status: 'running', output: { total: 2, earliest: 0 } }],
    ]),
    presets: [
      { id: 'standard', name: 'Standard mode', description: 'General work', isDefault: true },
      { id: 'minimal', description: 'Minimal mode', isDefault: false },
      { id: 'broken', name: 'Broken', isDefault: false, broken: 'missing service' },
      { nope: true },
      { id: '' },
    ],
    workspaceBaseline: {
      items: [{ workspaceId: 'w1', title: 'Work', path: '/work', sessionIds: ['s1'] }],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    workspaceFollowError: null,
    attachWait: null,
    loggerThrows: false,
    disposerThrows: false,
  };

  const agent = { id: 's1', session: { id: 's1', header: { cwd: '/work' } } };
  const liveAgents = new Map([['s1', agent]]);

  const controller = {
    async list() {
      calls.push(['session.list']);
      return { items: state.sessionItems };
    },
    follow(request, signal) {
      calls.push(['session.follow', request]);
      return (async function* follow() {
        if (state.followError !== null) throw state.followError;
        yield state.snapshot;
        for (const frame of state.followFrames) yield frame;
        await new Promise((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener?.('abort', resolve, { once: true });
        });
      })();
    },
    async prompt(request) {
      calls.push(['session.prompt', request]);
      return { accepted: true };
    },
    async cancel(request) {
      calls.push(['session.cancel', request]);
      return { accepted: true, cancelled: true };
    },
    async events(request) {
      calls.push(['session.events', request]);
      return state.historyPage ?? { cursor: request.beforeSeq - 1, records: [], hasMore: false };
    },
    async updateQueue(request) {
      calls.push(['session.updateQueue', request]);
      return { accepted: true };
    },
    async create(request) {
      calls.push(['session.create', request]);
      return { sessionId: 'created-1' };
    },
    async rename(request) {
      calls.push(['session.rename', request]);
      return { sessionId: request.sessionId, title: request.title };
    },
    async fork(request) {
      calls.push(['session.fork', request]);
      return { sessionId: 'fork-1' };
    },
    async modelCatalog() {
      calls.push(['session.modelCatalog']);
      return {
        default: { provider: 'p', model: 'm' },
        routableProviders: ['p'],
        groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }],
        failures: [],
      };
    },
    async selectModel(request) {
      calls.push(['session.selectModel', request]);
      return { selected: { provider: request.provider, model: request.model } };
    },
    async resolveAgent(sessionId) {
      calls.push(['session.resolveAgent', sessionId]);
      if (state.resolveAgentResult !== undefined) return state.resolveAgentResult;
      return { agent: liveAgents.get(String(sessionId)) };
    },
  };

  const shell = {
    resolve(request) {
      calls.push(['shell.resolve', request]);
      return request;
    },
  };
  const commands = {
    list(target) {
      calls.push(['commands.list', target]);
      return [
        { name: 'compact', description: 'Compact context', input: { hint: '' } },
        { name: 'plan', description: 'Enter plan mode', input: { hint: '<message>' } },
      ];
    },
    async execute(target, line, args, signal) {
      calls.push(['commands.execute', line, args, signal?.aborted === false]);
      return { commandId: 'cmd-1', result: { kind: 'success', text: `ran ${line}` } };
    },
  };
  const subagents = {
    async listDescendants(rootId) {
      calls.push(['subagents.listDescendants', rootId]);
      return state.subagentRows;
    },
    async listChildren(rootId) {
      calls.push(['subagents.listChildren', rootId]);
      return state.directChildren;
    },
    async prompt(request) {
      calls.push(['subagents.prompt', request]);
      return { messageId: 'message-1' };
    },
    sendMessage(parent, childId, content) {
      calls.push(['subagents.sendMessage', parent?.id, childId, content]);
      return 'message-legacy';
    },
    interruptByParent(childId, parentId, mode) {
      calls.push(['subagents.interruptByParent', childId, parentId, mode]);
      return { accepted: true };
    },
    interrupt(childId, options) {
      calls.push(['subagents.interrupt', childId, options]);
      return { accepted: true };
    },
  };
  const workspaceController = {
    async *follow(signal) {
      calls.push(['workspace.follow']);
      if (state.workspaceFollowError !== null) throw state.workspaceFollowError;
      if (state.workspaceBaseline === null) return;
      yield { type: 'baseline', value: state.workspaceBaseline };
      await new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener?.('abort', resolve, { once: true });
      });
    },
    async archiveSession(request) {
      calls.push(['workspace.archiveSession', request]);
      return { archivedSessionIds: [request.sessionId] };
    },
    async unarchiveSession(request) {
      calls.push(['workspace.unarchiveSession', request]);
      return { archivedSessionIds: [] };
    },
    async pinSession(request) {
      calls.push(['workspace.pinSession', request]);
      return { pinnedSessionIds: [request.sessionId] };
    },
    async unpinSession(request) {
      calls.push(['workspace.unpinSession', request]);
      return { pinnedSessionIds: [] };
    },
  };
  const agentPresets = {
    defaultId: 'standard',
    async remoteExportList() {
      calls.push(['presets.remoteExportList']);
      return { presets: state.presets };
    },
  };
  const goals = {
    get(target) {
      calls.push(['goals.get', target?.id]);
      if (state.goalGetError !== null) throw state.goalGetError;
      return state.goal;
    },
    complete(target, reference) {
      calls.push(['goals.complete', target?.id, reference]);
      state.goal = { ...state.goal, revision: reference.revision + 1, phase: 'complete', activation: 'disarmed' };
      return state.goal;
    },
  };
  const skills = {
    async snapshot(options) {
      calls.push(['skills.snapshot', options]);
      return { skills: state.skills, complete: true };
    },
    async list() {
      calls.push(['skills.list']);
      return state.skills;
    },
    async get(skillName) {
      calls.push(['skills.get', skillName]);
      return state.skills.find((skill) => skill.name === skillName);
    },
  };
  const jobs = {
    list(sessionId) {
      calls.push(['jobs.list', sessionId]);
      return [...state.jobs.values()];
    },
    get(jobId, sessionId) {
      calls.push(['jobs.get', jobId, sessionId]);
      const job = state.jobs.get(jobId);
      if (job === undefined) throw new Error('job not found');
      return job;
    },
    readAt(jobId, from, sessionId) {
      calls.push(['jobs.readAt', jobId, from, sessionId]);
      if (!state.jobs.has(jobId)) throw new Error('job not found');
      return { chunks: [{ at: from, text: 'ok' }], next: from + 1, lossy: false };
    },
    kill(jobId, sessionId, reason) {
      calls.push(['jobs.kill', jobId, sessionId, reason]);
      if (!state.jobs.has(jobId)) throw new Error('job not found');
      return 'requested';
    },
  };
  const typertGateway = { hasLiveClient: () => state.webLive };
  const userQuestions = {
    async *attachWait(target, callId, signal) {
      calls.push(['userQuestions.attachWait', callId]);
      state.attachWait = { target, callId, signal };
      yield 5;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  };

  const services = {
    agents: { get: (sessionId) => liveAgents.get(String(sessionId)) },
    commands,
    subagents,
    workspaceController,
    agentPresets,
    goals,
    shell,
    skills,
    jobs,
    typertGateway,
    userQuestions,
  };

  const workingDirectory = {
    async ensure(target) {
      calls.push(['workingDirectory.ensure', target?.id]);
      return '/work';
    },
  };

  const ctx = {
    sessionController: controller,
    workingDirectory,
    logger: {
      debug(message) {
        calls.push(['log', message]);
        if (state.loggerThrows) throw new Error('logger unavailable');
      },
      warn() {},
    },
    get(name) {
      return services[name];
    },
    on(name, fn) {
      listeners.set(name, fn);
      return () => {
        if (state.disposerThrows) throw new Error('disposer failed');
        listeners.delete(name);
      };
    },
  };

  return { ctx, services, state, calls, listeners, agent };
}

function restoreEnv(previous) {
  if (previous.home === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previous.home;
  if (previous.profile === undefined) delete process.env.DSH_PROFILE;
  else process.env.DSH_PROFILE = previous.profile;
}

/**
 * Start a real AttachServer against a fixture in an isolated DSH_HOME.
 *
 * @param {{fixture?: ReturnType<typeof createHostFixture>, config?: object, home?: string}} [options]
 */
export async function startAttachHost(options = {}) {
  const fixture = options.fixture ?? createHostFixture();
  const home = options.home ?? (await mkdtemp(join(tmpdir(), 'dsh-attach-routes-')));
  const previous = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE };
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE = 'routes';
  const server = new AttachServer(fixture.ctx, { ...DEFAULT_CONFIG, ...options.config });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await server.stop();
    if (options.home === undefined) await rm(home, { recursive: true, force: true });
    restoreEnv(previous);
  };
  try {
    await server.start();
    const descriptor = JSON.parse(await readFile(join(home, ENDPOINT_DIR, ENDPOINT_FILE), 'utf8'));
    return { ...fixture, home, server, descriptor, cleanup };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}

/**
 * Start a Host and connect a real AttachClient, then run `fn`.
 *
 * @param {(host: Awaited<ReturnType<typeof startAttachHost>> & {client: AttachClient}) => Promise<void>} fn
 * @param {{fixture?: ReturnType<typeof createHostFixture>, config?: object}} [options]
 */
export async function withAttachHost(fn, options = {}) {
  const host = await startAttachHost(options);
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await fn({ ...host, client });
  } finally {
    client.close();
    await host.cleanup();
  }
}

/**
 * Assert a route rejects with a stable attach error code and optional message.
 *
 * @param {Promise<unknown>} promise
 * @param {string} code
 * @param {RegExp} [message]
 */
export async function expectRouteError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
    if (message !== undefined) assert.match(error.message, message);
    return true;
  });
}

/** Write an arbitrary descriptor payload for cleanup/error tests. */
export async function writeEndpoint(home, payload) {
  await writeFile(join(home, ENDPOINT_DIR, ENDPOINT_FILE), payload, { mode: 0o600 });
}
