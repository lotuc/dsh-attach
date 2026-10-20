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
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { ENDPOINT_DIR, ENDPOINT_FILE, PROTOCOL_VERSION, encodeLine, takeLines } from '../shared/protocol.js';

export class AttachError extends Error {
  constructor(message, code = 'attach/error') {
    super(message);
    this.name = 'AttachError';
    this.code = code;
  }
}

function resolveDshHome() {
  const home = process.env.DSH_HOME?.trim();
  return home === undefined || home === '' ? join(homedir(), '.dsh') : home;
}

async function readDescriptor(path) {
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
 * Find candidate endpoint descriptors, newest first.
 * @param {string} [profile] - only descriptors written by this profile
 * @returns {Promise<string[]>}
 */
async function candidateDescriptors(profile) {
  const dir = join(resolveDshHome(), ENDPOINT_DIR);
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
  const filtered = profile === undefined ? ordered : [];
  if (profile !== undefined) {
    for (const path of ordered) {
      try {
        const descriptor = JSON.parse(await readFile(path, 'utf8'));
        if (descriptor?.profile === profile) filtered.push(path);
      } catch {
        // ignore malformed siblings
      }
    }
  }
  if (filtered.includes(primary)) {
    filtered.splice(filtered.indexOf(primary), 1);
    filtered.unshift(primary);
  }
  return filtered;
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
   * @param {{endpoint?: string, socketPath?: string, token?: string, profile?: string, timeoutMs?: number}} options
   */
  async connect(options = {}) {
    const candidates = [];
    if (options.socketPath !== undefined && options.token !== undefined) {
      candidates.push({ socketPath: options.socketPath, token: options.token, profile: options.profile ?? null });
    } else if (options.endpoint !== undefined) {
      candidates.push(await readDescriptor(options.endpoint));
    } else {
      const paths = await candidateDescriptors(options.profile);
      if (paths.length === 0) {
        throw new AttachError(
          `no attach endpoint under ${join(resolveDshHome(), ENDPOINT_DIR)}. ` +
            'Install dsh-tui-attach into the profile and restart DeepSeek Harness, then retry.',
          'attach/no-endpoint',
        );
      }
      for (const path of paths) {
        try {
          candidates.push(await readDescriptor(path));
        } catch {
          // stale or unrelated descriptor
        }
      }
    }

    const failures = [];
    for (const candidate of candidates) {
      try {
        await this.#dial(candidate, options.timeoutMs ?? 4_000);
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
   * @param {{endpoint?: string, socketPath?: string, token?: string, profile?: string, timeoutMs?: number}} options
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
    for (const pending of this.#pending.values()) {
      pending.reject(new AttachError('Host connection closed', 'attach/closed'));
    }
    this.#pending.clear();
    this.#buffer = { value: '' };
    this.host = null;
    this.config = null;
    this.descriptor = null;
    return this.connect(options);
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
      client: { name: 'dsh-attach', version: '0.14.0', protocol: PROTOCOL_VERSION },
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
        if (message.ok === true) pending.resolve(message.result);
        else pending.reject(new AttachError(message.error?.message ?? 'Host request failed', message.error?.code));
        return;
      }
      case 'frame':
        this.emit('frame', message);
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
    this.#welcome?.reject(new AttachError(error instanceof Error ? error.message : 'Host connection closed', 'attach/closed'));
    for (const pending of this.#pending.values()) {
      pending.reject(new AttachError('Host connection closed', 'attach/closed'));
    }
    this.#pending.clear();
    this.emit('close', error);
  }

  #teardown() {
    this.#closed = true;
    this.#socket?.destroy();
    this.#socket = null;
    this.#buffer = { value: '' };
  }

  /**
   * Send one request and await its response.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  request(method, params = {}) {
    if (this.#socket === null || this.#closed) {
      return Promise.reject(new AttachError('not connected', 'attach/closed'));
    }
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers();
    this.#pending.set(id, { resolve, reject });
    this.#socket.write(encodeLine({ type: 'request', id, method, params }));
    return promise;
  }

  /** Mark this terminal as recently active for `auto` interactive routing. */
  async activity() {
    try {
      await this.request('activity');
    } catch {
      // Activity is advisory.
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket?.end();
    this.#socket?.destroy();
    this.#socket = null;
  }
}
