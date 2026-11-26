/**
 * Terminal-side client for the local attach socket.
 *
 * One socket carries request/response pairs and Host notifications. Session
 * history and live events arrive as `frame` notifications; approvals and
 * questions arrive as interactive notifications and are answered with a
 * normal request.
 */
import { EventEmitter } from 'node:events';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';

import { ENDPOINT_DIR, ENDPOINT_FILE, PROTOCOL_VERSION, encodeLine, takeLines } from '../shared/protocol.js';
import { resolveDshHome } from '../shared/paths.js';
import { VERSION } from '../shared/version.js';

/** A request can legitimately wait for a long Host turn, but not forever. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

/** Local socket dial timeout when no SSH hop is involved. */
export const LOCAL_CONNECT_TIMEOUT_MS = 4_000;
/** SSH handshake timeout: network hop plus the remote local dial. */
export const SSH_CONNECT_TIMEOUT_MS = 15_000;

export class AttachError extends Error {
  constructor(message, code = 'attach/error') {
    super(message);
    this.name = 'AttachError';
    this.code = code;
  }
}

/**
 * Read and validate one endpoint descriptor. Shared with the remote
 * `--stdio-proxy` so both paths resolve the token and protocol identically.
 * @param {string} path
 * @returns {Promise<Record<string, any>>}
 */
export async function readDescriptor(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (parsed?.protocol !== PROTOCOL_VERSION) {
    throw new AttachError(`endpoint ${path} speaks protocol ${String(parsed?.protocol)}, expected ${String(PROTOCOL_VERSION)}`);
  }
  if (typeof parsed.socketPath !== 'string' || typeof parsed.token !== 'string') {
    throw new AttachError(`endpoint ${path} is missing socketPath/token`);
  }
  return parsed;
}

/**
 * Find candidate endpoint descriptors in one directory, newest first.
 * The canonical `endpoint.json` is tried before its timestamped siblings.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function descriptorsIn(dir) {
  const primary = join(dir, ENDPOINT_FILE);
  const found = [];
  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const path = join(dir, name);
      try {
        const info = await stat(path);
        found.push({ path, mtime: info.mtimeMs });
      } catch {
        // raced with cleanup
      }
    }
  } catch {
    // no directory yet
  }
  const ordered = found.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.path);
  if (ordered.includes(primary)) {
    ordered.splice(ordered.indexOf(primary), 1);
    ordered.unshift(primary);
  }
  return ordered;
}

/**
 * Find candidate endpoint descriptors. The canonical directory is scanned
 * first; within it the primary descriptor wins over timestamped siblings.
 * @param {string} [profile] - only descriptors written by this profile
 * @returns {Promise<string[]>}
 */
export async function candidateDescriptors(profile) {
  const home = resolveDshHome();
  const ordered = await descriptorsIn(join(home, ENDPOINT_DIR));
  if (profile === undefined) return ordered;
  const filtered = [];
  for (const path of ordered) {
    try {
      const descriptor = JSON.parse(await readFile(path, 'utf8'));
      if (descriptor?.profile === profile) filtered.push(path);
    } catch {
      // ignore malformed siblings
    }
  }
  return filtered;
}

/**
 * Resolve connection candidates from explicit socket/token, one descriptor, or
 * canonical discovery. Shared by `AttachClient` and `--stdio-proxy`.
 *
 * @param {{endpoint?: string, socketPath?: string, token?: string, profile?: string}} [options]
 * @returns {Promise<Array<{socketPath: string, token: string, profile?: string|null}>>}
 */
export async function resolveEndpointCandidates({ endpoint, socketPath, token, profile } = {}) {
  if (socketPath !== undefined && token !== undefined) {
    return [{ socketPath, token, profile: profile ?? null }];
  }
  if (endpoint !== undefined) {
    return [await readDescriptor(endpoint)];
  }
  const paths = await candidateDescriptors(profile);
  if (paths.length === 0) {
    const dir = join(resolveDshHome(), ENDPOINT_DIR);
    throw new AttachError(
      `no attach endpoint under ${dir}. ` +
        'Install dsh-attach into the profile, apply a DSH recomposition or restart, then retry.',
      'attach/no-endpoint',
    );
  }
  const candidates = [];
  for (const path of paths) {
    try {
      candidates.push(await readDescriptor(path));
    } catch {
      // stale or unrelated descriptor
    }
  }
  return candidates;
}

export class AttachClient extends EventEmitter {
  #socket = null;
  #buffer = { value: '' };
  #pending = new Map();
  #nextId = 1;
  #closed = false;
  #welcome;

  /** Resolved endpoint facts after connect(). */
  host = null;
  config = null;
  descriptor = null;

  /**
   * Connect and authenticate against the Host bridge.
   *
   * With `ssh`, the local descriptor is deliberately ignored: the remote
   * `--stdio-proxy` discovers it and injects the token. No local autostart is
   * ever attempted for this path.
   *
   * @param {{endpoint?: string, socketPath?: string, token?: string, profile?: string,
   *   timeoutMs?: number, ssh?: string, sshOpts?: string[], remoteBin?: string,
   *   batchMode?: boolean, spawn?: Function}} options
   */
  async connect(options = {}) {
    if (options.ssh !== undefined) {
      if (typeof options.ssh !== 'string' || options.ssh.trim() === '') {
        throw new AttachError('--ssh needs a target (user@host or an ssh alias)', 'attach/ssh-failed');
      }
      try {
        await this.#dialSsh(options);
        this.descriptor = null;
        return this;
      } catch (error) {
        this.#teardown();
        throw error;
      }
    }

    const candidates = await resolveEndpointCandidates(options);
    const failures = [];
    for (const candidate of candidates) {
      try {
        await this.#dial(candidate, options.timeoutMs ?? LOCAL_CONNECT_TIMEOUT_MS);
        this.descriptor = candidate;
        return this;
      } catch (error) {
        failures.push(`${candidate.socketPath}: ${error instanceof Error ? error.message : String(error)}`);
        this.#teardown();
      }
    }
    throw new AttachError(
      `cannot reach the attach bridge (${failures.join('; ') || 'no usable endpoint'})`,
      'attach/unreachable',
    );
  }

  /**
   * Replace the current socket with a fresh connection while keeping this
   * client's event listeners and configuration. Used after a Host restart.
   * @param {{endpoint?: string, socketPath?: string, token?: string, profile?: string,
   *   timeoutMs?: number, ssh?: string, sshOpts?: string[], remoteBin?: string,
   *   batchMode?: boolean, spawn?: Function}} options
   */
  async reconnect(options = {}) {
    const socket = this.#socket;
    this.#socket = null;
    this.#closed = true;
    if (socket !== null) {
      // The old close must not tear down or notify the replacement connection.
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      socket.destroy();
    }
    this.#welcome?.reject(new AttachError('reconnecting', 'attach/closed'));
    this.#rejectPending(new AttachError('Host connection closed', 'attach/closed'));
    this.#buffer = { value: '' };
    this.host = null;
    this.config = null;
    this.descriptor = null;
    return this.connect(options);
  }

  /**
   * Dial the Host through a spawned SSH byte proxy. The opening `hello` carries
   * an empty token on purpose; the remote proxy replaces it with the token from
   * the descriptor it discovers on that host.
   */
  async #dialSsh(options) {
    this.#closed = false;
    this.#buffer = { value: '' };
    const { createSshTransport } = await import('./ssh-transport.js');
    const transport = createSshTransport({
      target: options.ssh,
      profile: options.profile,
      endpoint: options.endpoint,
      remoteBin: options.remoteBin,
      sshOpts: options.sshOpts ?? [],
      batchMode: options.batchMode === true,
    }, { spawn: options.spawn });
    this.#socket = transport;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : SSH_CONNECT_TIMEOUT_MS;
    this.#welcome = Promise.withResolvers();
    transport.on('data', (chunk) => this.#onData(chunk));
    transport.on('error', (error) => this.#onClose(
      error instanceof Error ? error : new AttachError(String(error)),
    ));
    transport.on('close', (error) => this.#onClose(
      error instanceof Error ? error : undefined,
    ));
    transport.write(encodeLine({
      type: 'hello',
      token: '',
      client: { name: 'dsh-attach', version: VERSION, protocol: PROTOCOL_VERSION, features: ['interactive.ack'] },
    }));
    const timeout = setTimeout(() => {
      this.#welcome?.reject(new AttachError(
        `no Host handshake over SSH after ${timeoutMs}ms`,
        'attach/timeout',
      ));
    }, timeoutMs);
    timeout.unref?.();
    try {
      const welcome = await this.#welcome.promise;
      this.host = welcome.host;
      this.config = welcome.config;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #dial(candidate, timeoutMs) {
    this.#closed = false;
    this.#buffer = { value: '' };
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: candidate.socketPath });
      this.#socket = socket;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new AttachError(`connection timed out after ${timeoutMs}ms`, 'attach/timeout'));
      }, timeoutMs);
      timer.unref?.();
      const onError = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', onError);
        resolve();
      });
    });

    const socket = this.#socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    this.#welcome = Promise.withResolvers();
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => this.#onClose(error));
    socket.on('close', () => this.#onClose());
    socket.write(encodeLine({
      type: 'hello',
      token: candidate.token,
      client: { name: 'dsh-attach', version: VERSION, protocol: PROTOCOL_VERSION, features: ['interactive.ack'] },
    }));
    const timeout = setTimeout(() => {
      this.#welcome?.reject(new AttachError('timed out waiting for the Host handshake', 'attach/timeout'));
    }, timeoutMs);
    timeout.unref?.();
    try {
      const welcome = await this.#welcome.promise;
      this.host = welcome.host;
      this.config = welcome.config;
    } finally {
      clearTimeout(timeout);
    }
  }

  #onData(chunk) {
    let lines;
    try {
      lines = takeLines(this.#buffer, chunk);
    } catch {
      this.#onClose(new AttachError('malformed terminal input buffer'));
      return;
    }
    for (const line of lines) {
      if (line.trim() === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit('protocol-error', new AttachError('Host sent malformed JSON'));
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    switch (message?.type) {
      case 'welcome':
        this.#welcome?.resolve(message);
        return;
      case 'response': {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) return;
        this.#pending.delete(message.id);
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        if (message.ok === true) pending.resolve(message.result);
        else pending.reject(new AttachError(message.error?.message ?? 'Host request failed', message.error?.code));
        return;
      }
      case 'frame':
        this.emit('frame', message);
        return;
      case 'goal':
        this.emit('goal', message);
        return;
      case 'btw':
        this.emit('btw', message);
        return;
      case 'session.error':
        this.emit('session-error', message);
        return;
      case 'approval':
      case 'question':
        this.emit('interactive', message);
        return;
      case 'approval.closed':
      case 'question.closed':
        this.emit('interactive-closed', message);
        return;
      case 'error': {
        const error = new AttachError(message.error?.message ?? 'Host error', message.error?.code);
        this.#welcome?.reject(error);
        this.emit('protocol-error', error);
        return;
      }
      default:
        return;
    }
  }

  #onClose(error) {
    if (this.#closed) return;
    this.#closed = true;
    const attachError = error instanceof AttachError
      ? error
      : new AttachError(
        error instanceof Error ? error.message : 'Host connection closed',
        'attach/closed',
      );
    this.#welcome?.reject(attachError);
    this.#rejectPending(attachError);
    this.emit('close', attachError);
  }

  #teardown() {
    this.#closed = true;
    this.#socket?.destroy();
    this.#socket = null;
    this.#buffer = { value: '' };
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  /**
   * Send one request and await its response.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {{timeoutMs?: number}} [options] - 0 disables the bound
   * @returns {Promise<any>}
   */
  request(method, params = {}, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (this.#socket === null || this.#closed) {
      return Promise.reject(new AttachError('not connected', 'attach/closed'));
    }
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers();
    let timer;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        pending.reject(new AttachError(`request ${method} timed out after ${timeoutMs}ms`, 'attach/timeout'));
      }, timeoutMs);
      timer.unref?.();
    }
    this.#pending.set(id, { resolve, reject, timer });
    this.#socket.write(encodeLine({ type: 'request', id, method, params }));
    return promise;
  }

  /**
   * Mark this terminal as recently active for `auto` interactive routing.
   *
   * `timeoutMs` bounds the advisory request so a half-open SSH link cannot hang
   * the heartbeat; `throwOnTimeout` lets the TUI treat that bound as a stale
   * connection instead of silently ignoring it.
   *
   * @param {{timeoutMs?: number, throwOnTimeout?: boolean}} [options]
   */
  async activity({ timeoutMs, throwOnTimeout = false } = {}) {
    try {
      await this.request('activity', {}, timeoutMs === undefined ? {} : { timeoutMs });
    } catch (error) {
      if (throwOnTimeout === true) throw error;
      // Activity is advisory.
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new AttachError('client closed', 'attach/closed'));
    this.#socket?.end();
    this.#socket?.destroy();
    this.#socket = null;
  }
}
