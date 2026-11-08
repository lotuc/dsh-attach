/**
 * Host side of `dsh-attach`.
 *
 * The bridge lives inside the running DSH process, so it can use the real
 * `sessionController` instead of re-implementing session policy, queueing or
 * persistence. A terminal client connects over an owner-only Unix socket; the
 * socket carries newline-delimited JSON (see `../shared/protocol.js`).
 *
 * The bridge deliberately exposes no TCP listener. It is a local attach
 * surface, not a remote-access server.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { approvalReasonText } from '../shared/approval.js';
import { herdrEnvFromClient, mergeShellEnv } from './shell-env.js';
import { resolveDshHome } from '../shared/paths.js';
import { VERSION } from '../shared/version.js';
import { summarizeSubagents, mapSubagentRow } from './subagents.js';
import {
  controlSubagentRow,
  findSubagentRow,
  subagentControlCapabilities,
} from './subagent-control.js';
import {
  ENDPOINT_DIR,
  ENDPOINT_FILE,
  HELLO_TIMEOUT_MS,
  MAX_INBOUND_LINE_BYTES,
  MAX_OUTBOUND_LINE_BYTES,
  PROTOCOL_VERSION,
  encodeLine,
  takeLines,
} from '../shared/protocol.js';

/** JSONL history is capped so a very large session cannot pin unbounded memory. */
const FOLLOW_MAX_MESSAGES = 300;
/** Soft cap for one socket's outbound buffer before we wait for drain. */
const WRITE_HIGH_WATER = 4 * 1024 * 1024;

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

function tokenMatches(expectedHash, candidate) {
  if (typeof candidate !== 'string') return false;
  const actual = hashToken(candidate);
  return expectedHash.length === actual.length && timingSafeEqual(expectedHash, actual);
}

/** Stable Host failure for an attach route. */
function attachFailure(code, message, cause) {
  return Object.assign(new Error(message), { code }, cause === undefined ? {} : { cause });
}

/** Stable, actionable text for one subagent control failure. */
const SUBAGENT_CONTROL_ERRORS = Object.freeze({
  'subagent/parent-unavailable': 'the subagent parent is not live; open the parent session first',
  'subagent/not-resumable': 'only continuable subagents can be continued',
  'subagent/unauthorized': 'the Host does not authorize this subagent control request',
  'subagent/delivery-unavailable': 'the subagent cannot accept a message right now',
  'subagent/attachment-invalid': 'the subagent rejected the message content',
  'gateway/bad-request': 'the subagent control request is invalid',
  'gateway/cancelled': 'the subagent control request was cancelled',
});

/**
 * Map a core (non-Remote) subagent failure onto the stable control codes the
 * Remote surface uses, so the client shows the same text for either path.
 *
 * @param {string} code
 * @returns {string}
 */
function normalizeSubagentControlCode(code) {
  switch (code) {
    case 'UNAUTHORIZED':
      return 'subagent/unauthorized';
    case 'NOT_RESUMABLE':
      return 'subagent/not-resumable';
    case 'PARENT_UNAVAILABLE':
      return 'subagent/parent-unavailable';
    case 'CANCELLED':
      return 'gateway/cancelled';
    case 'ACTIVATION_LIMIT_REACHED':
    case 'ACTIVATION_CLOSING':
    case 'CONTINUATION_UNAVAILABLE':
    case 'PERSISTENCE_UNAVAILABLE':
    case 'DRAINING':
      return 'subagent/delivery-unavailable';
    default:
      return code;
  }
}

/**
 * Preserve the runtime's failure code while replacing transport wording with
 * a message the TUI can show directly.
 *
 * @param {unknown} error
 * @param {'continue'|'interrupt'} action
 * @returns {Error & { code: string }}
 */
function subagentControlFailure(error, action) {
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = rawCode === '' ? `subagent/${action}-failed` : normalizeSubagentControlCode(rawCode);
  const causeMessage = error?.cause instanceof Error ? error.cause.message : '';
  const message = SUBAGENT_CONTROL_ERRORS[code]
    ?? (causeMessage || (error instanceof Error ? error.message : String(error)));
  return attachFailure(code, message, error);
}

function summarizeSession(summary) {
  const values = summary?.projections?.values ?? {};
  const title = typeof values.title === 'string' && values.title.trim() !== '' ? values.title : null;
  const cwd = summary?.cwd ?? (typeof values.workingDirectory === 'string' ? values.workingDirectory : null);
  const model = values.modelSelection?.lastUsed ?? values.modelSelection?.next ?? null;
  return {
    sessionId: String(summary.sessionId),
    title,
    cwd: typeof cwd === 'string' ? cwd : null,
    updatedAt: Number(summary.updatedAt ?? 0),
    running: summary.running === true,
    blank: summary.blank === true,
    parentSessionId: summary.parentSessionId === undefined ? null : String(summary.parentSessionId),
    origin: summary.origin ?? null,
    agentAvailable: summary.agentAvailable !== false,
    agentPreset: typeof values.agentPreset === 'string' ? values.agentPreset : null,
    model,
    blankHint: values.sessionListMetadata?.blank === true,
  };
}

/** One accepted client socket. Owns at most one followed Session. */
class AttachConnection {
  #server;
  #socket;
  #buffer = { value: '' };
  #authenticated = false;
  #disposed = false;
  #helloDeadline;
  #requestSeq = 0;
  #openGeneration = 0;
  #followAbort;
  #writeChain = Promise.resolve();

  constructor(server, socket) {
    this.#server = server;
    this.#socket = socket;
    this.sessionId = null;
    this.sessionAddress = null;
    this.clientName = null;
    this.features = new Set();
    this.lastActionAt = 0;
    this.#helloDeadline = setTimeout(() => {
      if (!this.#authenticated) this.dispose('handshake timeout');
    }, HELLO_TIMEOUT_MS);
    this.#helloDeadline.unref?.();
  }

  get authenticated() {
    return this.#authenticated;
  }

  /** Mark a real user action so interactive requests prefer this terminal. */
  touch() {
    this.lastActionAt = Date.now();
  }

  /** Whether this client advertised an optional protocol feature. */
  supports(feature) {
    return this.features.has(feature);
  }

  start() {
    this.#socket.setEncoding('utf8');
    this.#socket.setNoDelay(true);
    this.#socket.on('data', (chunk) => {
      if (this.#disposed) return;
      let lines;
      try {
        lines = takeLines(this.#buffer, chunk);
      } catch {
        this.dispose('line buffer failure');
        return;
      }
      if (this.#buffer.value.length > MAX_INBOUND_LINE_BYTES) {
        this.dispose('frame too large');
        return;
      }
      for (const line of lines) {
        if (this.#disposed) return;
        if (line.trim() === '') continue;
        this.#onLine(line);
      }
    });
    this.#socket.on('error', () => this.dispose('socket error'));
    this.#socket.on('close', () => this.dispose('socket closed'));
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.dispose('malformed json');
      return;
    }
    if (!this.#authenticated) {
      if (message?.type !== 'hello' || tokenMatches(this.#server.tokenHash, message.token) !== true) {
        this.send({ type: 'error', error: { code: 'attach/unauthorized', message: 'invalid attach token' } });
        this.dispose('unauthorized');
        return;
      }
      this.#authenticated = true;
      clearTimeout(this.#helloDeadline);
      this.clientName = typeof message.client?.name === 'string' ? message.client.name : 'dsh-attach';
      for (const feature of Array.isArray(message.client?.features) ? message.client.features : []) {
        if (typeof feature === 'string') this.features.add(feature);
      }
      this.#server.connections.add(this);
      this.send({
        type: 'welcome',
        protocol: PROTOCOL_VERSION,
        host: this.#server.hostInfo,
        config: this.#server.publicConfig,
      });
      return;
    }
    if (message?.type === 'request') {
      void this.#handleRequest(message);
    }
  }

  async #handleRequest(message) {
    const id = message.id;
    if (!Number.isSafeInteger(id)) return;
    const method = typeof message.method === 'string' ? message.method : '';
    try {
      const result = await this.#server.route(this, method, message.params ?? {});
      this.send({ type: 'response', id, ok: true, result: result ?? null });
    } catch (error) {
      this.send({
        type: 'response',
        id,
        ok: false,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'attach/internal',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /** Send one message, respecting backpressure so snapshots do not pile up. */
  send(message) {
    if (this.#disposed) return Promise.resolve();
    let line;
    try {
      line = encodeLine(message);
    } catch (error) {
      line = encodeLine({ type: 'error', error: { code: 'attach/encode', message: String(error) } });
    }
    if (Buffer.byteLength(line, 'utf8') > MAX_OUTBOUND_LINE_BYTES) {
      line = encodeLine({ type: 'error', error: { code: 'attach/too-large', message: 'outbound frame too large' } });
    }
    this.#writeChain = this.#writeChain.then(async () => {
      if (this.#disposed) return;
      if (this.#socket.writableLength > WRITE_HIGH_WATER) {
        await new Promise((resolve) => this.#socket.once('drain', resolve));
      }
      if (this.#disposed) return;
      this.#socket.write(line);
    }).catch(() => {});
    return this.#writeChain;
  }

  /** Follow one Session, replacing any stream already open on this socket. */
  openSession(sessionId, options = {}) {
    const controller = this.#server.ctx.sessionController;
    if (sessionId === null || sessionId === undefined || String(sessionId) === '') {
      throw Object.assign(new Error('sessionId is required'), { code: 'attach/bad-request' });
    }
    const id = String(sessionId);
    const parentSessionId = options?.parentSessionId === undefined || options?.parentSessionId === null
      ? null
      : String(options.parentSessionId);
    const mode = options?.mode === 'one-shot' || options?.mode === 'continuable' ? options.mode : 'unknown';
    const previous = this.sessionId;
    if (previous !== null) this.#server.clearSessionEnv(this, previous);
    this.#server.setSessionEnv(this, id, options?.env);

    this.#followAbort?.abort();
    this.#followAbort = undefined;
    this.#openGeneration += 1;
    const generation = this.#openGeneration;
    this.sessionId = id;
    this.touch();
    this.#server.sessionChanged(this, previous, id);

    const abort = new AbortController();
    this.#followAbort = abort;
    const address = parentSessionId === null || parentSessionId === ''
      ? { kind: 'session', sessionId: id }
      : { kind: 'subagent', parentSessionId, childSessionId: id, mode };
    this.sessionAddress = address;
    const iterable = controller.follow({
      address,
      assistantStream: true,
      maxMessages: this.#server.historyLimit(),
    }, abort.signal);

    void this.#pump(iterable, id, generation, abort);
    return { sessionId: id };
  }

  async #pump(iterable, sessionId, generation, abort) {
    try {
      for await (const frame of iterable) {
        if (this.#disposed || abort.signal.aborted || generation !== this.#openGeneration) return;
        // Following a live session is activity: keep `auto` routing pointed at
        // this terminal for approvals that arrive during a long turn.
        this.touch();
        await this.send({ type: 'frame', sessionId, frame });
      }
    } catch (error) {
      if (this.#disposed || abort.signal.aborted || generation !== this.#openGeneration) return;
      this.send({
        type: 'session.error',
        sessionId,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'attach/follow',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  closeSession() {
    const previous = this.sessionId;
    this.#openGeneration += 1;
    this.#followAbort?.abort();
    this.#followAbort = undefined;
    this.sessionId = null;
    this.sessionAddress = null;
    this.#server.clearSessionEnv(this, previous);
    this.#server.sessionChanged(this, previous, null);
    return { closed: true };
  }

  /** Durable address of the followed Session, used for cold history reads. */
  followedAddress() {
    if (this.sessionId === null) return null;
    return this.sessionAddress ?? { kind: 'session', sessionId: this.sessionId };
  }

  dispose(reason) {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#helloDeadline);
    this.#openGeneration += 1;
    this.#followAbort?.abort();
    this.#followAbort = undefined;
    this.#server.detachConnection(this);
    this.#server.connections.delete(this);
    this.#server.debug(`attach connection disposed: ${reason}`);
    this.#socket.destroy();
  }
}

/** Owns the Unix socket, endpoint descriptor and interactive routing. */
export class AttachServer {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.connections = new Set();
    this.pending = new Map();
    this.#token = randomBytes(32).toString('base64url');
    this.tokenHash = hashToken(this.#token);
    this.socketPath = null;
    this.#server = null;
    this.#disposers = [];
    this.#started = false;
  }

  #server;
  #token;
  #disposers = [];
  #started = false;
  /** Short catalog labels for the active subagents, refreshed only on change. */
  #subagentLabels = new Map();
  /** Client-provided Herdr facts keyed by followed session. */
  #sessionEnv = new Map();
  #shellService = null;
  #shellOriginal = null;
  #shellWrapper = null;

  get hostInfo() {
    const workspace = this.#workspaceController();
    const presets = this.#agentPresetService();
    const subagentControl = subagentControlCapabilities(this.ctx.get('subagents'));
    const goals = this.ctx.get('goals') ?? this.ctx.goals;
    return {
      pid: process.pid,
      home: resolveDshHome(),
      profile: process.env.DSH_PROFILE ?? null,
      node: process.versions.node,
      pluginVersion: VERSION,
      protocol: PROTOCOL_VERSION,
      capabilities: [
        'session.open.subagent',
        'workspace.list',
        'subagent.list',
        'subagent.children',
        'subagent.summary',
        ...(subagentControl.continue ? ['subagent.continue'] : []),
        ...(subagentControl.interrupt ? ['subagent.interrupt'] : []),
        'commands',
        ...(this.ctx.get('jobs') === undefined ? [] : ['jobs']),
        'goal.activation',
        ...(typeof goals?.get === 'function' && typeof goals?.complete === 'function' ? ['goal.complete'] : []),
        ...(typeof this.ctx.sessionController?.updateQueue === 'function' ? ['queue.update'] : []),
        ...(typeof this.ctx.sessionController?.events === 'function'
          || typeof this.ctx.sessionController?.page === 'function' ? ['history.pagination'] : []),
        ...(typeof this.ctx.sessionController?.fork === 'function' ? ['session.fork'] : []),
        ...(typeof workspace?.archiveSession === 'function' && typeof workspace?.unarchiveSession === 'function'
          ? ['session.archive']
          : []),
        ...(typeof workspace?.pinSession === 'function' && typeof workspace?.unpinSession === 'function'
          ? ['session.pin']
          : []),
        ...(this.#presetRosterAvailable(presets) ? ['session.presets'] : []),
      ],
    };
  }

  get publicConfig() {
    return {
      approvals: this.config.approvals,
      questions: this.config.questions,
      activeWindowMinutes: this.config.activeWindowMinutes,
      approvalGraceSeconds: this.config.approvalGraceSeconds,
      questionGraceSeconds: this.config.questionGraceSeconds,
    };
  }

  graceMs(kind) {
    const seconds = kind === 'approval' ? this.config.approvalGraceSeconds : this.config.questionGraceSeconds;
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
  }

  /** Limit how much history one snapshot can pull into the client. */
  historyLimit() {
    const configured = Number(this.config.historyMessages);
    if (!Number.isFinite(configured) || configured <= 0) return FOLLOW_MAX_MESSAGES;
    return Math.min(5_000, Math.floor(configured));
  }

  debug(message) {
    try {
      this.ctx.logger?.debug?.(`[dsh-attach] ${message}`);
    } catch {
      // Diagnostics must never break the bridge.
    }
  }

  async start() {
    if (this.#started) return;
    this.#started = true;
    this.#installShellEnvBridge();
    const home = resolveDshHome();
    const dir = join(home, ENDPOINT_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});

    let socketPath = this.config.socketPath?.trim() ?? '';
    if (socketPath === '') {
      socketPath = join(dir, `attach-${process.pid}.sock`);
      if (Buffer.byteLength(socketPath, 'utf8') > 100) {
        socketPath = join(tmpdir(), `dsh-attach-${process.pid}.sock`);
      }
    }
    await unlink(socketPath).catch(() => {});
    const server = net.createServer((socket) => {
      const conn = new AttachConnection(this, socket);
      conn.start();
    });
    server.on('error', (error) => this.debug(`server error: ${String(error)}`));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(socketPath);
    });
    await chmod(socketPath, 0o600).catch(() => {});
    this.#server = server;
    this.socketPath = socketPath;

    const descriptor = {
      protocol: PROTOCOL_VERSION,
      plugin: 'dsh-attach',
      pluginVersion: VERSION,
      pid: process.pid,
      socketPath,
      token: this.#token,
      profile: process.env.DSH_PROFILE ?? null,
      home,
      startedAt: Date.now(),
    };
    await this.#writeDescriptor(dir, descriptor);
    this.#installInteractiveListeners();
    this.debug(`listening on ${socketPath}`);
  }

  async #writeDescriptor(dir, descriptor) {
    const payload = `${JSON.stringify(descriptor, null, 2)}\n`;
    const targets = [
      join(dir, `${descriptor.profile ?? 'default'}-${process.pid}.json`),
      join(dir, ENDPOINT_FILE),
    ];
    for (const target of targets) {
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, payload, { mode: 0o600 });
      await chmod(temporary, 0o600).catch(() => {});
      await rename(temporary, target).catch(async (error) => {
        await unlink(temporary).catch(() => {});
        throw error;
      });
    }
  }

  #installInteractiveListeners() {
    const server = this;
    const approval = function (request, next) {
      return server.#onApproval(request, next);
    };
    const question = function (request, next) {
      return server.#onQuestion(request, next);
    };
    this.#disposers.push(this.ctx.on('approval/request', approval, { prepend: true }));
    this.#disposers.push(this.ctx.on('user-questions/request', question, { prepend: true }));
    this.#disposers.push(this.ctx.on('goal/activation-changed', (payload) => server.#broadcastGoalActivation(payload)));
  }

  #broadcastGoalActivation(payload) {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
    if (sessionId === '') return;
    const goal = payload?.goal !== null && typeof payload?.goal === 'object' ? payload.goal : null;
    for (const conn of this.connections) {
      if (conn.sessionId !== sessionId) continue;
      conn.send({ type: 'goal', sessionId, goal });
    }
  }

  /** Remember the narrow Herdr facts that belong to this connection's session. */
  setSessionEnv(conn, sessionId, value) {
    const env = herdrEnvFromClient(value);
    if (Object.keys(env).length === 0) {
      this.clearSessionEnv(conn, sessionId);
      return;
    }
    this.#sessionEnv.set(String(sessionId), { conn, env });
    this.#installShellEnvBridge();
  }

  clearSessionEnv(conn, sessionId) {
    if (sessionId === null || sessionId === undefined) return;
    const key = String(sessionId);
    const entry = this.#sessionEnv.get(key);
    if (entry?.conn === conn) this.#sessionEnv.delete(key);
  }

  #installShellEnvBridge() {
    if (this.#shellService !== null) return;
    const shell = this.ctx.get('shell') ?? this.ctx.shell;
    if (shell === undefined || shell === null || typeof shell.resolve !== 'function') return;
    const original = shell.resolve.bind(shell);
    const wrapper = (request) => {
      const sessionId = typeof request?.dshEnv?.DSH_SESSION_ID === 'string' ? request.dshEnv.DSH_SESSION_ID : '';
      return original(mergeShellEnv(request, this.#sessionEnv.get(sessionId)?.env));
    };
    try {
      shell.resolve = wrapper;
    } catch {
      return;
    }
    this.#shellService = shell;
    this.#shellOriginal = original;
    this.#shellWrapper = wrapper;
  }

  #restoreShellEnvBridge() {
    if (this.#shellService === null) return;
    try {
      if (this.#shellService.resolve === this.#shellWrapper) this.#shellService.resolve = this.#shellOriginal;
    } catch {
      // A replaced/frozen shell service is left alone.
    }
    this.#shellService = null;
    this.#shellOriginal = null;
    this.#shellWrapper = null;
  }

  #skillService() {
    return this.ctx.get('skills') ?? this.ctx.skills;
  }

  async #skillLookup(conn) {
    if (conn.sessionId === null) throw Object.assign(new Error('no session is open'), { code: 'attach/no-session' });
    const agent = this.ctx.get('agents')?.get?.(conn.sessionId);
    if (agent === undefined || agent === null) return null;
    const signal = AbortSignal.timeout(5000);
    let cwd;
    try {
      cwd = await this.ctx.workingDirectory?.ensure?.(agent, signal);
    } catch {
      cwd = undefined;
    }
    return { scope: agent, cwd, signal };
  }

  async #skillList(conn) {
    const skills = this.#skillService();
    if (skills === undefined || skills === null) return { supported: false, complete: false, skills: [] };
    const options = await this.#skillLookup(conn);
    if (options === null) return { supported: false, complete: false, skills: [] };
    const snapshot = typeof skills.snapshot === 'function'
      ? await skills.snapshot(options)
      : { skills: await skills.list(options), complete: true };
    return {
      supported: true,
      complete: snapshot?.complete !== false,
      skills: (Array.isArray(snapshot?.skills) ? snapshot.skills : [])
        .filter((skill) => skill?.invocation?.userInvocable !== false)
        .slice(0, 200)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          ...(typeof skill.whenToUse === 'string' ? { whenToUse: skill.whenToUse } : {}),
          ...(typeof skill.path === 'string' ? { path: skill.path } : {}),
          provider: skill.provider,
          source: skill.source,
          modelInvocable: skill.invocation?.modelInvocable !== false,
        })),
    };
  }

  async #skillGet(conn, params) {
    const skills = this.#skillService();
    if (skills === undefined || skills === null) return { supported: false, skill: null };
    const options = await this.#skillLookup(conn);
    if (options === null) return { supported: false, skill: null };
    const name = typeof params?.name === 'string' ? params.name : '';
    const skill = await skills.get(name, options);
    if (skill === undefined || skill === null || skill.invocation?.userInvocable === false) {
      return { supported: true, skill: null };
    }
    return {
      supported: true,
      skill: {
        name: skill.name,
        description: skill.description,
        ...(typeof skill.whenToUse === 'string' ? { whenToUse: skill.whenToUse } : {}),
        ...(typeof skill.path === 'string' ? { path: skill.path } : {}),
        provider: skill.provider,
        source: skill.source,
        content: typeof skill.content === 'string' ? skill.content : '',
      },
    };
  }

  #webLive() {
    try {
      return this.ctx.get('typertGateway')?.hasLiveClient?.() === true;
    } catch {
      return false;
    }
  }

  #watchingConnections(sessionId) {
    const watching = [];
    for (const conn of this.connections) {
      if (conn.authenticated && conn.sessionId === sessionId) watching.push(conn);
    }
    return watching;
  }

  #tuiOwns(conn, mode) {
    if (conn === undefined) return false;
    if (mode === 'off' || mode === 'web') return false;
    if (mode === 'tui') return true;
    const windowMs = Math.max(0, Number(this.config.activeWindowMinutes ?? 10)) * 60_000;
    if (windowMs > 0 && Date.now() - conn.lastActionAt <= windowMs) return true;
    return !this.#webLive();
  }

  #sendPending(entry, conn) {
    if (entry.settled || conn === undefined) return;
    if (entry.conns.has(conn)) return;
    entry.conns.add(conn);
    if (entry.kind === 'approval') {
      const request = entry.request;
      conn.send({
        type: 'approval',
        requestId: entry.id,
        sessionId: entry.sessionId,
        toolName: typeof request?.toolName === 'string' ? request.toolName : 'tool',
        reason: approvalReasonText(request?.reason) || null,
        displayReason: approvalReasonText(request?.displayReason) || null,
        callId: request?.callId ?? null,
      });
    } else {
      conn.send({
        type: 'question',
        requestId: entry.id,
        sessionId: entry.sessionId,
        questions: entry.request?.questions ?? [],
        wait: entry.request?.wait ?? null,
      });
    }
  }

  #broadcastPending(entry) {
    const mode = entry.kind === 'approval' ? this.config.approvals : this.config.questions;
    for (const conn of this.#watchingConnections(entry.sessionId)) {
      if (this.#tuiOwns(conn, mode)) this.#sendPending(entry, conn);
    }
  }

  /** Start the Web answerer (the next waterfall listener) without abandoning late TUI attach. */
  #startWeb(entry) {
    if (entry.webStarted || entry.settled) return;
    entry.webStarted = true;
    Promise.resolve()
      .then(() => entry.next())
      .then((value) => {
        if (entry.settled) return;
        if (value !== undefined) {
          this.#settlePending(entry, value);
          return;
        }
        entry.webDone = true;
        if (entry.conns.size === 0) this.#settlePending(entry, undefined);
      })
      .catch(() => {
        entry.webDone = true;
        if (entry.conns.size === 0) this.#settlePending(entry, undefined);
      });
  }

  #onPendingGrace(entry) {
    if (entry.settled || entry.webStarted) return;
    // A client that advertises interactive.ack tells us whether the panel was
    // actually shown. A connected-but-unacked terminal (for example one with a
    // picker covering the request) should not hold the request past grace.
    // Older clients have no acknowledgement capability; keep their historical
    // single-owner behavior.
    const capable = [...entry.conns].filter((conn) => conn.supports('interactive.ack'));
    if (capable.length !== entry.conns.size) return;
    if (capable.some((conn) => entry.acks.has(conn))) return;
    if (this.#webLive()) {
      this.#startWeb(entry);
      return;
    }
    this.#settlePending(entry, undefined);
  }

  #createPending(kind, request, sessionId, next) {
    const { promise, resolve } = Promise.withResolvers();
    const entry = {
      id: randomUUID(),
      kind,
      sessionId,
      request,
      next,
      promise,
      resolve,
      conns: new Set(),
      acks: new Set(),
      settled: false,
      webStarted: false,
      webDone: false,
      timer: undefined,
      abort: undefined,
      claim: kind === 'question' ? this.#claimTimedWait(request) : undefined,
    };
    this.pending.set(entry.id, entry);
    const signal = request?.signal;
    if (signal?.aborted) {
      this.#settlePending(entry, undefined);
      return entry;
    }
    const onAbort = () => this.#settlePending(entry, undefined);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    entry.abort = onAbort;
    this.#broadcastPending(entry);
    if (entry.conns.size === 0 && this.#webLive()) this.#startWeb(entry);
    const graceMs = this.graceMs(kind);
    if (graceMs > 0) {
      entry.timer = setTimeout(() => this.#onPendingGrace(entry), graceMs);
      entry.timer.unref?.();
    }
    return entry;
  }

  #settlePending(entry, value) {
    if (entry.settled) return;
    entry.settled = true;
    this.pending.delete(entry.id);
    clearTimeout(entry.timer);
    entry.request?.signal?.removeEventListener?.('abort', entry.abort);
    if (value === undefined) entry.claim?.close();
    else setTimeout(() => entry.claim?.close(), 0).unref?.();
    entry.resolve(value);
    const closedType = entry.kind === 'approval' ? 'approval.closed' : 'question.closed';
    for (const conn of entry.conns) {
      conn.send({ type: closedType, requestId: entry.id, sessionId: entry.sessionId });
    }
    entry.conns.clear();
    entry.acks.clear();
  }

  resolvePending(requestId, value) {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false;
    this.#settlePending(entry, value);
    return true;
  }

  /** Remove one connection's overlay without settling the shared request. */
  detachPending(conn, requestId) {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false;
    entry.acks.delete(conn);
    if (entry.conns.delete(conn)) {
      const closedType = entry.kind === 'approval' ? 'approval.closed' : 'question.closed';
      conn.send({ type: closedType, requestId, sessionId: entry.sessionId });
    }
    return true;
  }

  /** Replay pending interactions when a terminal opens (or switches to) a session. */
  sessionChanged(conn, oldSessionId, newSessionId) {
    for (const entry of this.pending.values()) {
      if (entry.settled) continue;
      const mode = entry.kind === 'approval' ? this.config.approvals : this.config.questions;
      if (entry.sessionId !== newSessionId) {
        entry.acks.delete(conn);
        if (entry.conns.delete(conn)) {
          const closedType = entry.kind === 'approval' ? 'approval.closed' : 'question.closed';
          conn.send({ type: closedType, requestId: entry.id, sessionId: entry.sessionId });
        }
        continue;
      }
      if (this.#tuiOwns(conn, mode)) this.#sendPending(entry, conn);
    }
  }

  detachConnection(conn) {
    this.clearSessionEnv(conn, conn.sessionId);
    for (const entry of this.pending.values()) {
      entry.acks.delete(conn);
      if (!entry.conns.delete(conn)) continue;
      if (entry.settled || entry.webStarted || entry.conns.size > 0) continue;
      // The terminal that owned this request is gone. Hand it to the Web
      // answerer if one is live, otherwise release it back to the Host
      // waterfall immediately.
      if (this.#webLive()) this.#startWeb(entry);
      else this.#settlePending(entry, undefined);
    }
  }

  async #onApproval(request, next) {
    const sessionId = request?.agent?.session?.id;
    if (sessionId === undefined) return next();
    if (this.config.approvals === 'web' || this.config.approvals === 'off') return next();
    const entry = this.#createPending('approval', request, String(sessionId), next);
    const outcome = await entry.promise;
    if (outcome === undefined) {
      if (entry.webStarted) return undefined;
      return next();
    }
    return outcome;
  }

  /**
   * Hold a timed question's foreground wait for the terminal.
   *
   * `askTimed` waits for a client to claim the wait before it can turn a
   * delegated request into a pending result. The Web UI claims it through
   * `userQuestions.attachWait`; the terminal must do the same, otherwise
   * dismissing the panel would leave the tool call running until its timeout.
   * @param {object} request - host user-questions request
   * @returns {{close: () => void}|undefined}
   */
  #claimTimedWait(request) {
    const wait = request?.wait;
    if (wait?.timed !== true || typeof wait.callId !== 'string' || request.agent === undefined) return undefined;
    const service = this.ctx.get('userQuestions');
    if (service === undefined || typeof service.attachWait !== 'function') return undefined;
    const abort = new AbortController();
    const task = (async () => {
      try {
        for await (const _remaining of service.attachWait(request.agent, wait.callId, abort.signal)) {
          // The opening frame is only the Host-computed remaining duration.
        }
      } catch {
        // The wait can end or its agent can disappear; neither breaks the bridge.
      }
    })();
    return {
      close: () => {
        abort.abort();
        void task;
      },
    };
  }

  async #onQuestion(request, next) {
    const sessionId = request?.agent?.session?.id;
    if (sessionId === undefined) return next();
    if (this.config.questions === 'web' || this.config.questions === 'off') return next();
    const entry = this.#createPending('question', request, String(sessionId), next);
    const answer = await entry.promise;
    if (answer === undefined) {
      if (entry.webStarted) return undefined;
      return next();
    }
    return answer;
  }

  /** Resolve the live Agent for a session, resuming it only for an explicit command. */
  async #resolveAgent(sessionId) {
    const agents = this.ctx.get('agents');
    const live = agents?.get?.(sessionId);
    if (live !== undefined && live !== null) return live;
    const found = await this.ctx.sessionController.resolveAgent(sessionId);
    if (found?.agent !== undefined) return found.agent;
    const message = found?.error?.message ?? `cannot resolve session ${sessionId}`;
    throw Object.assign(new Error(message), { code: found?.error?.code ?? 'attach/no-agent' });
  }

  /** Workspace mutations are optional: headless deployments may not mount them. */
  #workspaceController() {
    return this.ctx.get('workspaceController') ?? this.ctx.workspaceController;
  }

  /** The Agent-preset registry is optional; the bridge only reads its roster. */
  #agentPresetService() {
    return this.ctx.get('agentPresets') ?? this.ctx.agentPresets;
  }

  #presetRosterAvailable(presets = this.#agentPresetService()) {
    return presets !== undefined
      && presets !== null
      && (typeof presets.remoteExportList === 'function' || typeof presets.list === 'function');
  }

  /** Resolve a lifecycle target from an explicit Session or the followed Session. */
  #targetSessionId(conn, params) {
    const explicit = typeof params?.sessionId === 'string' ? params.sessionId.trim() : '';
    const value = explicit !== '' ? explicit : conn.sessionId;
    if (value === null || value === undefined || String(value) === '') {
      throw Object.assign(new Error('sessionId is required'), { code: 'attach/bad-request' });
    }
    return String(value);
  }

  /** Read the Agent-preset roster in the shape the terminal selector consumes. */
  async #presetRoster() {
    const presets = this.#agentPresetService();
    if (!this.#presetRosterAvailable(presets)) return { supported: false, presets: [] };
    let rows;
    try {
      rows = typeof presets.remoteExportList === 'function'
        ? (await presets.remoteExportList())?.presets
        : await presets.list();
    } catch (error) {
      throw Object.assign(
        new Error(`cannot read the agent-preset catalog: ${error instanceof Error ? error.message : String(error)}`),
        { code: 'attach/presets-unavailable' },
      );
    }
    const defaultId = typeof presets.defaultId === 'string' ? presets.defaultId : null;
    return {
      supported: true,
      ...(defaultId === null ? {} : { defaultId }),
      presets: (Array.isArray(rows) ? rows : [])
        .filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id !== '')
        .map((row) => ({
          id: row.id,
          name: typeof row.name === 'string' && row.name !== '' ? row.name : null,
          description: typeof row.description === 'string' && row.description !== '' ? row.description : null,
          isDefault: row.isDefault === true || row.id === defaultId,
          ...(typeof row.broken === 'string' && row.broken !== '' ? { broken: row.broken } : {}),
        })),
    };
  }

  /** Read the current Workspace baseline (registry order + session membership). */
  async #workspaceSnapshot() {
    const controller = this.ctx.get('workspaceController');
    if (controller === undefined || typeof controller.follow !== 'function') {
      return { items: [], archivedSessionIds: [], pinnedSessionIds: [] };
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5_000);
    timer.unref?.();
    try {
      for await (const frame of controller.follow(abort.signal)) {
        if (frame?.type === 'baseline') {
          const value = frame.value ?? {};
          return {
            items: (value.items ?? []).map((workspace) => ({
              workspaceId: workspace.workspaceId,
              title: workspace.title,
              path: workspace.path,
              sessionIds: workspace.sessionIds ?? [],
            })),
            archivedSessionIds: value.archivedSessionIds ?? [],
            pinnedSessionIds: value.pinnedSessionIds ?? [],
          };
        }
      }
    } catch {
      // A Workspace view is optional decoration for the picker.
    } finally {
      abort.abort();
      clearTimeout(timer);
    }
    return { items: [], archivedSessionIds: [], pinnedSessionIds: [] };
  }

  /** Discover commands for the followed session without resuming its Agent. */
  #commandList(conn) {
    const commands = this.ctx.get('commands');
    if (commands === undefined) return [];
    const agents = this.ctx.get('agents');
    const agent = conn.sessionId === null ? undefined : agents?.get?.(conn.sessionId);
    return commands.list(agent).map((command) => ({
      name: command.name,
      description: command.description ?? '',
      ...(typeof command.input?.hint === 'string' && command.input.hint !== '' ? { argumentHint: command.input.hint } : {}),
    }));
  }

  #jobsService() {
    const jobs = this.ctx.get('jobs');
    if (jobs === undefined || jobs === null) {
      throw Object.assign(new Error('background jobs are unavailable in this Host'), { code: 'job/unavailable' });
    }
    return jobs;
  }

  listJobs(sessionId) {
    const jobs = this.#jobsService();
    return { jobs: jobs.list(sessionId) };
  }

  readJob(sessionId, jobId, from) {
    const jobs = this.#jobsService();
    const offset = from === undefined ? 0 : Number(from);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw Object.assign(new Error('from must be a non-negative safe integer'), { code: 'attach/bad-request' });
    }
    try {
      const read = jobs.readAt(jobId, offset, sessionId);
      return {
        chunks: Array.isArray(read?.chunks) ? read.chunks : [],
        next: Number(read?.next) || offset,
        lossy: read?.lossy === true,
        job: jobs.get(jobId, sessionId),
      };
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: 'job/not-found' });
    }
  }

  /**
   * Read one cold-safe older page of the followed Session.
   *
   * DSH's `sessionController.events` is the supported history API: the caller
   * supplies an exclusive `beforeSeq` cursor and a message budget, and receives
   * a chronological page plus `hasMore`. `page` is the deprecated equivalent
   * kept as a fallback for older Host builds.
   *
   * @param {AttachConnection} conn
   * @param {{beforeSeq?: unknown}} params
   * @returns {Promise<object>}
   */
  async readHistory(conn, params) {
    if (conn.sessionId === null) {
      throw Object.assign(new Error('no session is open'), { code: 'attach/no-session' });
    }
    const controller = this.ctx.sessionController;
    const read = typeof controller?.events === 'function'
      ? controller.events.bind(controller)
      : typeof controller?.page === 'function'
        ? controller.page.bind(controller)
        : null;
    if (read === null) {
      throw Object.assign(
        new Error('this Host does not expose Session history pagination'),
        { code: 'history/unavailable' },
      );
    }
    const beforeSeq = params?.beforeSeq;
    if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0) {
      throw Object.assign(
        new Error('beforeSeq must be a non-negative safe integer'),
        { code: 'attach/bad-request' },
      );
    }
    const address = conn.followedAddress();
    const value = await read({
      address,
      beforeSeq,
      maxMessages: this.historyLimit(),
    }, AbortSignal.timeout(30_000));
    const records = Array.isArray(value?.records) ? value.records : [];
    let oldestSeq = null;
    let newestSeq = null;
    for (const record of records) {
      const seq = record?.type === 'event' ? record.event?.seq : undefined;
      if (!Number.isSafeInteger(seq) || seq < 0) continue;
      if (oldestSeq === null || seq < oldestSeq) oldestSeq = seq;
      if (newestSeq === null || seq > newestSeq) newestSeq = seq;
    }
    return {
      records,
      hasMore: value?.hasMore === true,
      cursor: Number.isSafeInteger(value?.cursor) ? value.cursor : null,
      oldestSeq,
      newestSeq,
      beforeSeq,
    };
  }

  updateQueue(sessionId, itemId, action) {
    const controller = this.ctx.sessionController;
    if (typeof controller?.updateQueue !== 'function') {
      throw Object.assign(new Error('queue edits are unavailable in this Host'), { code: 'queue/unavailable' });
    }
    const kind = action?.kind;
    if (kind !== 'remove' && kind !== 'steer' && kind !== 'edit') {
      throw Object.assign(new Error('queue action must be remove, steer, or edit'), { code: 'attach/bad-request' });
    }
    const request = { sessionId, itemId, action: { kind } };
    if (kind === 'edit') {
      const text = typeof action.text === 'string' ? action.text : '';
      if (text.trim() === '') throw Object.assign(new Error('queue edit text is empty'), { code: 'attach/bad-request' });
      request.action = { kind: 'edit', content: [{ type: 'text', text }] };
    }
    return controller.updateQueue(request);
  }

  killJob(sessionId, jobId) {
    const jobs = this.#jobsService();
    try {
      return {
        outcome: jobs.kill(jobId, sessionId, 'cancelled by the user'),
        job: jobs.get(jobId, sessionId),
      };
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: 'job/not-found' });
    }
  }

  /**
   * Resolve one target child from the open session's durable catalog.
   *
   * Control never trusts a client-supplied parent id: the catalog row supplies
   * the direct parent used by DSH's `interruptByParent` and prompt authority.
   *
   * @param {string} rootSessionId
   * @param {string} childId
   * @returns {Promise<object>}
   */
  async #requireSubagentRow(rootSessionId, childId) {
    const runtime = this.ctx.get('subagents');
    if (runtime === undefined || typeof runtime.listDescendants !== 'function') {
      throw attachFailure('subagent/control-unavailable', 'this Host cannot enumerate subagent lineage');
    }
    let rows;
    try {
      rows = await runtime.listDescendants(rootSessionId, AbortSignal.timeout(15_000));
    } catch (error) {
      throw attachFailure('subagent/control-unavailable', 'cannot read the subagent catalog', error);
    }
    const row = findSubagentRow(rows, childId);
    if (row === null) {
      throw attachFailure('attach/not-found', `subagent "${childId}" is not in this session's lineage`);
    }
    return row;
  }

  /**
   * Deliver a human follow-up prompt to one continuable child.
   *
   * Uses the Host's addressed subagent prompt (`subagents.prompt`) when the
   * runtime exposes it, preserving the user-authored message source and Queue
   * or Steer delivery. Older runtimes fall back to the adjacent-Agent
   * `sendMessage` primitive, which requires the exact live direct parent.
   *
   * @param {AttachConnection} conn
   * @param {object} params
   * @returns {Promise<{supported: boolean, accepted?: boolean, messageId?: string, reason?: string}>}
   */
  async continueSubagent(conn, params) {
    if (conn.sessionId === null) throw attachFailure('attach/no-session', 'no session is open');
    const runtime = this.ctx.get('subagents');
    const control = subagentControlCapabilities(runtime);
    if (!control.continue) {
      return { supported: false, reason: 'this Host does not expose subagent continuation' };
    }
    const childId = typeof params.childId === 'string' ? params.childId.trim() : '';
    const text = typeof params.text === 'string' ? params.text.trim() : '';
    if (childId === '') throw attachFailure('attach/bad-request', 'childId is required');
    if (text === '') throw attachFailure('attach/bad-request', 'text is required');
    const row = await this.#requireSubagentRow(conn.sessionId, childId);
    if (row.mode !== 'continuable') {
      throw attachFailure('subagent/not-resumable', SUBAGENT_CONTROL_ERRORS['subagent/not-resumable']);
    }
    const agents = this.ctx.get('agents');
    const parent = agents?.get?.(String(row.parentId));
    if (parent === undefined || parent === null) {
      throw attachFailure('subagent/parent-unavailable', SUBAGENT_CONTROL_ERRORS['subagent/parent-unavailable']);
    }
    const delivery = params.delivery === 'steer' ? 'steer' : 'queue';
    const content = [{ type: 'text', text }];
    let clientTimeZone;
    try {
      clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      clientTimeZone = undefined;
    }
    conn.touch();
    try {
      if (typeof runtime.prompt === 'function') {
        const receipt = await runtime.prompt({
          requestId: randomUUID(),
          parentSessionId: String(row.parentId),
          childSessionId: String(row.id),
          mode: 'continuable',
          delivery,
          content,
          ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
        }, AbortSignal.timeout(120_000));
        return {
          supported: true,
          accepted: true,
          messageId: String(receipt?.messageId ?? ''),
        };
      }
      const messageId = await runtime.sendMessage(parent, String(row.id), content, {
        signal: AbortSignal.timeout(120_000),
      });
      return { supported: true, accepted: true, messageId: String(messageId) };
    } catch (error) {
      throw subagentControlFailure(error, 'continue');
    }
  }

  /**
   * Stop a child's current turn, or the currently viewed subagent's turn.
   *
   * DSH has one user-facing stop primitive: `interrupt` addressed by the
   * durable direct parent. "Stop" and "cancel" are aliases for it; there is no
   * separate durable child-termination remote method.
   *
   * @param {AttachConnection} conn
   * @param {object} params
   * @returns {Promise<{supported: boolean, accepted?: boolean, reason?: string}>}
   */
  async interruptSubagent(conn, params) {
    if (conn.sessionId === null) throw attachFailure('attach/no-session', 'no session is open');
    const runtime = this.ctx.get('subagents');
    const control = subagentControlCapabilities(runtime);
    if (!control.interrupt) {
      return { supported: false, reason: 'this Host does not expose subagent interruption' };
    }
    const childId = typeof params.childId === 'string' ? params.childId.trim() : '';
    if (childId === '') throw attachFailure('attach/bad-request', 'childId is required');
    let parentId = typeof params.parentSessionId === 'string' ? params.parentSessionId.trim() : '';
    if (childId === conn.sessionId) {
      // The viewed subagent is not one of its own descendants. Its direct
      // parent is supplied by the client or recovered from the session list;
      // `interruptByParent` still authorizes the address against the live
      // activation.
      if (parentId === '') {
        try {
          const value = await this.ctx.sessionController.list({}, AbortSignal.timeout(10_000));
          const summary = (value?.items ?? []).find((item) => String(item.sessionId) === childId);
          if (summary?.origin === 'subagent' && summary.parentSessionId !== undefined) {
            parentId = String(summary.parentSessionId);
          }
        } catch {
          // Fall through to the bad-request failure below.
        }
      }
      if (parentId === '') {
        throw attachFailure('attach/bad-request', 'parentSessionId is required to interrupt the current subagent');
      }
    } else {
      const row = await this.#requireSubagentRow(conn.sessionId, childId);
      parentId = String(row.parentId);
    }
    conn.touch();
    try {
      if (typeof runtime.interruptByParent === 'function') {
        const receipt = runtime.interruptByParent(childId, parentId, 'continuable');
        return { supported: true, accepted: receipt?.accepted !== false };
      }
      runtime.interrupt(childId, { kind: 'user', parentSessionId: parentId });
      return { supported: true, accepted: true };
    } catch (error) {
      throw subagentControlFailure(error, 'interrupt');
    }
  }

  /**
   * Route one attach request. Each protocol family has a focused handler; the
   * top-level switch only classifies the method so the wire protocol and its
   * unknown-method error stay in one place.
   */
  async route(conn, method, params) {
    const controller = this.ctx.sessionController;
    const dot = typeof method === 'string' ? method.indexOf('.') : -1;
    const group = dot === -1 ? method : method.slice(0, dot);
    switch (group) {
      case 'host':
        if (method === 'host.describe') {
          return {
            host: this.hostInfo,
            config: this.publicConfig,
            socketPath: this.socketPath,
          };
        }
        return this.#unknownRoute(method);
      case 'session':
        return this.#routeSession(conn, method, params, controller);
      case 'queue':
      case 'job':
        return this.#routeJobs(conn, method, params);
      case 'history':
        return this.#routeHistory(conn, method, params);
      case 'model':
        if (method === 'model.catalog') return controller.modelCatalog();
        return this.#unknownRoute(method);
      case 'commands':
        return this.#routeCommands(conn, method, params);
      case 'skill':
        return this.#routeSkills(conn, method, params);
      case 'goal':
        return this.#routeGoal(conn, method);
      case 'workspace':
        if (method === 'workspace.list') return this.#workspaceSnapshot();
        return this.#unknownRoute(method);
      case 'subagent':
        return this.#routeSubagent(conn, method, params, controller);
      case 'interactive':
      case 'approval':
      case 'question':
        return this.#routeInteractive(conn, method, params);
      case 'activity':
        if (method === 'activity') {
          conn.touch();
          return { ok: true };
        }
        return this.#unknownRoute(method);
      default:
        return this.#unknownRoute(method);
    }
  }

  #unknownRoute(method) {
    throw Object.assign(new Error(`unknown attach method: ${method}`), { code: 'attach/unknown-method' });
  }

  async #routeSession(conn, method, params, controller) {
    switch (method) {
      case 'session.list': {
        const value = await controller.list({}, AbortSignal.timeout(30_000));
        const items = (value?.items ?? []).map(summarizeSession);
        return { items };
      }
      case 'session.open':
        return conn.openSession(params.sessionId, params);
      case 'session.close':
        return conn.closeSession();
      case 'session.prompt':
        return this.#routeSessionPrompt(conn, params, controller);
      case 'session.cancel': {
        if (conn.sessionId === null) throw Object.assign(new Error('no session is open'), { code: 'attach/no-session' });
        conn.touch();
        return controller.cancel({ sessionId: conn.sessionId });
      }
      case 'session.create':
        return this.#routeSessionCreate(conn, params, controller);
      case 'session.rename':
        return this.#routeSessionRename(conn, params, controller);
      case 'session.fork':
        return this.#routeSessionFork(conn, params, controller);
      case 'session.archive':
      case 'session.unarchive':
      case 'session.pin':
      case 'session.unpin':
        return this.#routeSessionWorkspace(conn, method, params);
      case 'session.presets':
        return this.#presetRoster();
      case 'session.selectModel':
        return this.#routeSessionSelectModel(conn, params, controller);
      default:
        return this.#unknownRoute(method);
    }
  }

  /** Create a session with only the explicitly supplied overrides. */
  async #routeSessionCreate(conn, params, controller) {
    const request = {};
    if (typeof params.cwd === 'string' && params.cwd !== '') request.cwd = params.cwd;
    if (typeof params.agentPreset === 'string' && params.agentPreset !== '') request.agentPreset = params.agentPreset;
    if (typeof params.sessionId === 'string' && params.sessionId !== '') request.sessionId = params.sessionId;
    conn.touch();
    return controller.create(request);
  }

  /** Rename the followed session after rejecting an empty title. */
  async #routeSessionRename(conn, params, controller) {
    if (conn.sessionId === null) throw Object.assign(new Error('no session is open'), { code: 'attach/no-session' });
    const title = typeof params.title === 'string' ? params.title.trim() : '';
    if (title === '') throw Object.assign(new Error('title is empty'), { code: 'attach/bad-request' });
    conn.touch();
    return controller.rename({ sessionId: conn.sessionId, title });
  }

  /** Select a provider/model for the followed session. */
  async #routeSessionSelectModel(conn, params, controller) {
    if (conn.sessionId === null) throw Object.assign(new Error('no session is open'), { code: 'attach/no-session' });
    const provider = typeof params.provider === 'string' ? params.provider : '';
    const model = typeof params.model === 'string' ? params.model : '';
    if (provider === '' || model === '') throw Object.assign(new Error('provider and model are required'), { code: 'attach/bad-request' });
    conn.touch();
    const selection = { provider, model };
    if (typeof params.reasoningEffort === 'string' && params.reasoningEffort !== '') selection.reasoningEffort = params.reasoningEffort;
    return controller.selectModel({ sessionId: conn.sessionId, ...selection });
  }

  /** Validate and submit a prompt, including its attached image payload. */
  async #routeSessionPrompt(conn, params, controller) {
    if (conn.sessionId === null) throw Object.assign(new Error('no session is open'), { code: 'attach/no-session' });
    const text = typeof params.text === 'string' ? params.text : '';
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const images = (Array.isArray(params.images) ? params.images : [])
      .filter((image) => image !== null && typeof image === 'object')
      .map((image) => ({
        mediaType: image.mediaType,
        data: typeof image.data === 'string' ? image.data : '',
        name: typeof image.name === 'string' ? image.name : 'clipboard.png',
      }))
      .filter((image) => allowed.has(image.mediaType) && image.data !== '');
    if (images.length > 8) throw Object.assign(new Error('too many images'), { code: 'attach/bad-request' });
    if (images.some((image) => image.data.length > 32 * 1024 * 1024)) {
      throw Object.assign(new Error('image is too large'), { code: 'attach/bad-request' });
    }
    if (text.trim() === '' && images.length === 0) {
      throw Object.assign(new Error('prompt content is empty'), { code: 'attach/bad-request' });
    }
    const mode = params.mode === 'steer' ? 'steer' : 'queue';
    const requestId = typeof params.requestId === 'string' && params.requestId !== '' ? params.requestId : randomUUID();
    const content = [];
    if (text.trim() !== '') content.push({ type: 'text', text });
    for (const image of images) content.push({ type: 'image', ...image });
    conn.touch();
    await controller.prompt({
      requestId,
      sessionId: conn.sessionId,
      mode,
      content,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, AbortSignal.timeout(120_000));
    return { accepted: true, requestId };
  }

  /** Fork from the followed session or an explicit target override. */
  async #routeSessionFork(conn, params, controller) {
    if (typeof controller.fork !== 'function') {
      throw Object.assign(new Error('session forking is unavailable in this Host'), { code: 'session/fork-unavailable' });
    }
    const sessionId = this.#targetSessionId(conn, params);
    const request = { sessionId };
    if (params.atSeq !== undefined) {
      if (!Number.isSafeInteger(params.atSeq) || params.atSeq < 0) {
        throw Object.assign(new Error('atSeq must be a non-negative safe integer'), { code: 'attach/bad-request' });
      }
      request.atSeq = params.atSeq;
    }
    if (typeof params.allowMigration === 'boolean') request.allowMigration = params.allowMigration;
    conn.touch();
    return controller.fork(request);
  }

  /** Archive, unarchive, pin, or unpin the target session via workspace. */
  async #routeSessionWorkspace(conn, method, params) {
    const workspace = this.#workspaceController();
    switch (method) {
      case 'session.archive': {
        if (typeof workspace?.archiveSession !== 'function') {
          throw Object.assign(new Error('session archival is unavailable in this Host'), { code: 'session/archive-unavailable' });
        }
        const sessionId = this.#targetSessionId(conn, params);
        const request = { sessionId };
        if (params.stopActivity === true) request.stopActivity = true;
        conn.touch();
        return workspace.archiveSession(request);
      }
      case 'session.unarchive': {
        if (typeof workspace?.unarchiveSession !== 'function') {
          throw Object.assign(new Error('session unarchival is unavailable in this Host'), { code: 'session/archive-unavailable' });
        }
        const sessionId = this.#targetSessionId(conn, params);
        conn.touch();
        return workspace.unarchiveSession({ sessionId });
      }
      case 'session.pin': {
        if (typeof workspace?.pinSession !== 'function') {
          throw Object.assign(new Error('session pinning is unavailable in this Host'), { code: 'session/pin-unavailable' });
        }
        const sessionId = this.#targetSessionId(conn, params);
        conn.touch();
        return workspace.pinSession({ sessionId });
      }
      case 'session.unpin': {
        if (typeof workspace?.unpinSession !== 'function') {
          throw Object.assign(new Error('session unpinning is unavailable in this Host'), { code: 'session/pin-unavailable' });
        }
        const sessionId = this.#targetSessionId(conn, params);
        conn.touch();
        return workspace.unpinSession({ sessionId });
      }
      default:
        return this.#unknownRoute(method);
    }
  }

  async #routeJobs(conn, method, params) {
    switch (method) {
      case 'queue.update': {
        if (conn.sessionId === null) throw Object.assign(new Error('no session is open'), { code: 'attach/no-session' });
        const itemId = typeof params.itemId === 'string' ? params.itemId : '';
        if (itemId === '') throw Object.assign(new Error('itemId is required'), { code: 'attach/bad-request' });
        conn.touch();
        return this.updateQueue(conn.sessionId, itemId, params.action);
      }
      case 'job.list': {
        if (conn.sessionId === null) throw Object.assign(new Error('no session is open'), { code: 'attach/no-session' });
        conn.touch();
        return this.listJobs(conn.sessionId);
      }
      case 'job.read': {
        if (conn.sessionId === null) throw Object.assign(new Error('no session is open'), { code: 'attach/no-session' });
        const jobId = typeof params.jobId === 'string' ? params.jobId : '';
        if (jobId === '') throw Object.assign(new Error('jobId is required'), { code: 'attach/bad-request' });
        conn.touch();
        return this.readJob(conn.sessionId, jobId, params.from);
      }
      case 'job.kill': {
        if (conn.sessionId === null) throw Object.assign(new Error('no session is open'), { code: 'attach/no-session' });
        const jobId = typeof params.jobId === 'string' ? params.jobId : '';
        if (jobId === '') throw Object.assign(new Error('jobId is required'), { code: 'attach/bad-request' });
        conn.touch();
        return this.killJob(conn.sessionId, jobId);
      }
      default:
        return this.#unknownRoute(method);
    }
  }

  async #routeHistory(conn, method, params) {
    if (method !== 'history.events') return this.#unknownRoute(method);
    if (conn.sessionId === null) throw Object.assign(new Error('no session is open'), { code: 'attach/no-session' });
    conn.touch();
    return this.readHistory(conn, params);
  }

  async #routeCommands(conn, method, params) {
    switch (method) {
      case 'commands.list':
        return { commands: this.#commandList(conn) };
      case 'commands.execute': {
        if (conn.sessionId === null) throw Object.assign(new Error('no session is open'), { code: 'attach/no-session' });
        const line = typeof params.line === 'string' ? params.line.trim() : '';
        if (!line.startsWith('/')) throw Object.assign(new Error('command line must start with /'), { code: 'attach/bad-request' });
        const commands = this.ctx.get('commands');
        if (commands === undefined) throw Object.assign(new Error('the Host has no command registry'), { code: 'attach/no-commands' });
        const agent = await this.#resolveAgent(conn.sessionId);
        const execution = await commands.execute(agent, line, [], AbortSignal.timeout(120_000));
        if (execution === undefined) return { executed: false };
        conn.touch();
        return {
          executed: true,
          commandId: String(execution.commandId),
          result: execution.result,
        };
      }
      default:
        return this.#unknownRoute(method);
    }
  }

  async #routeSkills(conn, method, params) {
    switch (method) {
      case 'skill.list':
        return this.#skillList(conn);
      case 'skill.get':
        return this.#skillGet(conn, params);
      default:
        return this.#unknownRoute(method);
    }
  }

  async #routeGoal(conn, method) {
    switch (method) {
      case 'goal.get': {
        if (conn.sessionId === null) throw Object.assign(new Error('no session is open'), { code: 'attach/no-session' });
        const agent = this.ctx.get('agents')?.get?.(conn.sessionId);
        if (agent === undefined || agent === null) return { supported: false, goal: null };
        const goals = this.ctx.get('goals') ?? this.ctx.goals;
        if (goals === undefined || typeof goals.get !== 'function') return { supported: false, goal: null };
        try {
          return { supported: true, goal: goals.get(agent) ?? null };
        } catch {
          return { supported: false, goal: null };
        }
      }
      case 'goal.complete': {
        if (conn.sessionId === null) throw Object.assign(new Error('no session is open'), { code: 'attach/no-session' });
        const goals = this.ctx.get('goals') ?? this.ctx.goals;
        if (goals === undefined || goals === null || typeof goals.get !== 'function' || typeof goals.complete !== 'function') {
          throw Object.assign(new Error('this Host does not expose goal completion'), { code: 'attach/unsupported' });
        }
        const agent = await this.#resolveAgent(conn.sessionId);
        const current = goals.get(agent);
        if (current === undefined || current === null) {
          throw Object.assign(new Error('no goal is currently set'), { code: 'goal/not-found' });
        }
        conn.touch();
        const goal = goals.complete(agent, { id: current.id, revision: current.revision });
        return { completed: true, goal };
      }
      default:
        return this.#unknownRoute(method);
    }
  }

  async #routeSubagent(conn, method, params, controller) {
    switch (method) {
      case 'subagent.summary':
        return this.#subagentSummary(params, controller);
      case 'subagent.children':
        return this.#subagentChildren(params);
      case 'subagent.list':
        return this.#subagentList(params);
      case 'subagent.continue':
        return this.continueSubagent(conn, params);
      case 'subagent.interrupt':
        return this.interruptSubagent(conn, params);
      default:
        return this.#unknownRoute(method);
    }
  }

  /**
   * Return counters plus the small active window. session.list is large;
   * keeping the 800-row payload out of the TUI process avoids a periodic
   * client-side parse and keeps typing latency flat.
   */
  async #subagentSummary(params, controller) {
    const rootId = String(params.sessionId ?? '');
    if (rootId === '') {
      throw Object.assign(new Error('sessionId is required'), { code: 'attach/bad-request' });
    }
    const value = await controller.list({}, AbortSignal.timeout(10_000));
    const items = value?.items ?? [];
    const { total, running, active } = summarizeSubagents(items, rootId);
    // Session titles for subagents are often the full task prompt. The
    // catalog also carries a short human label ("Reviewer", "Verify cwd"),
    // which is what the bottom peek should show. Cache labels for the
    // active set so a steady stream of polls does not keep hitting the
    // catalog.
    const wanted = new Set(active.map((item) => item.id));
    for (const id of this.#subagentLabels.keys()) {
      if (!wanted.has(id)) this.#subagentLabels.delete(id);
    }
    if (active.some((item) => !this.#subagentLabels.has(item.id))) {
      const runtime = this.ctx.get('subagents');
      if (runtime !== undefined && typeof runtime.listDescendants === 'function') {
        try {
          // Remember that these IDs were looked up even when the catalog
          // does not return a label, so a missing entry does not trigger a
          // lookup on every poll.
          for (const id of wanted) {
            if (!this.#subagentLabels.has(id)) this.#subagentLabels.set(id, null);
          }
          // Labels only need the active direct children. Walking every
          // descendant here made a summary poll recurse through hundreds
          // of catalogs (and once took ~14s on a 108-child session).
          const rows = await runtime.listChildren(rootId, AbortSignal.timeout(2_000));
          for (const row of Array.isArray(rows) ? rows : []) {
            const id = row?.id === undefined ? '' : String(row.id);
            const label = typeof row.label === 'string' ? row.label.trim() : '';
            if (wanted.has(id) && label !== '') this.#subagentLabels.set(id, label);
          }
        } catch {
          // A transient catalog failure should be retried on the next poll;
          // the session title is still a usable fallback.
          for (const id of wanted) {
            if (this.#subagentLabels.get(id) === null) this.#subagentLabels.delete(id);
          }
        }
      }
    }
    for (const item of active) {
      const label = this.#subagentLabels.get(item.id);
      if (typeof label === 'string') item.label = label;
    }
    return { supported: true, total, running, active };
  }

  async #subagentChildren(params) {
    const runtime = this.ctx.get('subagents');
    if (runtime === undefined || typeof runtime.listChildren !== 'function') {
      return { supported: false, items: [] };
    }
    const rootId = String(params.sessionId ?? '');
    if (rootId === '') {
      throw Object.assign(new Error('sessionId is required'), { code: 'attach/bad-request' });
    }
    const control = subagentControlCapabilities(runtime);
    try {
      const direct = await runtime.listChildren(rootId, AbortSignal.timeout(2_000));
      const agents = this.ctx.get('agents');
      const parentActive = (parentId) => agents?.get?.(String(parentId)) !== undefined;
      if (direct.length <= 32 && typeof runtime.listDescendants === 'function') {
        const rows = await runtime.listDescendants(rootId, AbortSignal.timeout(15_000));
        return {
          supported: true,
          directOnly: false,
          control,
          items: rows
            .filter((row) => row?.kind === 'child')
            .map((row) => {
              const mapped = mapSubagentRow(row);
              return controlSubagentRow(mapped, control, parentActive(mapped.parentId));
            }),
        };
      }
      return {
        supported: true,
        directOnly: true,
        control,
        items: direct.map((row) => {
          const mapped = mapSubagentRow(row, {
            parentId: rootId,
            depth: 1,
            activity: agents?.get?.(String(row.id)) === undefined ? 'inactive' : 'running',
          });
          return controlSubagentRow(mapped, control, parentActive(rootId));
        }),
      };
    } catch {
      return { supported: false, items: [] };
    }
  }

  async #subagentList(params) {
    const runtime = this.ctx.get('subagents');
    if (runtime === undefined || typeof runtime.listDescendants !== 'function') {
      return { supported: false, items: [] };
    }
    try {
      const rows = await runtime.listDescendants(String(params.sessionId), AbortSignal.timeout(15_000));
      return {
        supported: true,
        items: rows
          .filter((row) => row?.kind === 'child')
          .map((row) => mapSubagentRow(row)),
      };
    } catch {
      return { supported: false, items: [] };
    }
  }

  #routeInteractive(conn, method, params) {
    switch (method) {
      case 'interactive.ack': {
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        const entry = this.pending.get(requestId);
        if (entry === undefined || entry.settled || !entry.conns.has(conn)) return { accepted: false };
        entry.acks.add(conn);
        return { accepted: true };
      }
      case 'interactive.detach': {
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        if (!this.detachPending(conn, requestId)) {
          throw Object.assign(new Error('interaction is no longer pending'), { code: 'attach/not-open' });
        }
        return { accepted: true };
      }
      case 'approval.respond': {
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        const outcome = params.outcome === 'allowed-once' ? 'allowed-once' : params.outcome === 'rejected' ? 'rejected' : null;
        if (outcome === null) throw Object.assign(new Error('approval outcome must be allowed-once or rejected'), { code: 'attach/bad-request' });
        if (!this.resolvePending(requestId, outcome)) {
          throw Object.assign(new Error('approval request is no longer pending'), { code: 'attach/not-open' });
        }
        return { accepted: true };
      }
      case 'question.respond': {
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        const answers = params.answers;
        if (!Array.isArray(answers)) throw Object.assign(new Error('answers must be an array'), { code: 'attach/bad-request' });
        if (!this.resolvePending(requestId, { answers })) {
          throw Object.assign(new Error('question request is no longer pending'), { code: 'attach/not-open' });
        }
        return { accepted: true };
      }
      case 'question.cancel': {
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        if (!this.resolvePending(requestId, undefined)) {
          throw Object.assign(new Error('question request is no longer pending'), { code: 'attach/not-open' });
        }
        return { accepted: true };
      }
      case 'approval.cancel': {
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        if (!this.resolvePending(requestId, undefined)) {
          throw Object.assign(new Error('approval request is no longer pending'), { code: 'attach/not-open' });
        }
        return { accepted: true };
      }
      default:
        return this.#unknownRoute(method);
    }
  }

  async stop() {
    if (!this.#started) return;
    this.#started = false;
    for (const dispose of this.#disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
    for (const entry of [...this.pending.values()]) this.#settlePending(entry, undefined);
    this.pending.clear();
    this.#subagentLabels.clear();
    this.#sessionEnv.clear();
    this.#restoreShellEnvBridge();
    for (const conn of [...this.connections]) conn.dispose('server stopping');
    this.connections.clear();
    const server = this.#server;
    this.#server = null;
    if (server !== null) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    const socketPath = this.socketPath;
    this.socketPath = null;
    if (socketPath !== null) await unlink(socketPath).catch(() => {});
    await this.#removeDescriptor();
  }

  async #removeDescriptor() {
    const dir = join(resolveDshHome(), ENDPOINT_DIR);
    const endpoint = join(dir, ENDPOINT_FILE);
    try {
      const raw = await readFile(endpoint, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.token === this.#token) await unlink(endpoint).catch(() => {});
    } catch {
      // Descriptor already gone or replaced by another instance.
    }
    await unlink(join(dir, `${process.env.DSH_PROFILE ?? 'default'}-${process.pid}.json`)).catch(() => {});
  }
}
