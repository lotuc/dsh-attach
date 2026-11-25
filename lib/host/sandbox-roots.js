/**
 * Runtime session writable roots for the attach bridge.
 *
 * DSH's `@deepseek-ai/dsh-sandbox-policy` service owns per-session directory
 * grants: `registerWritableRoot(session, directory)` returns a disposer and only
 * accepts an exact live Session plus a physical absolute directory. The bridge
 * therefore keeps its own small bookkeeping: one entry per Session and physical
 * directory, a set of owning connections, and the disposer from DSH.
 *
 * The service is optional. An older Host without `sandboxPolicy` degrades to
 * "unsupported" without throwing, and a bad directory (missing, relative,
 * symlinked, `SANDBOX_INVALID_ROOT`) never breaks `session.open` or an approval.
 */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { isFilesystemRoot } from '../shared/session-allow.js';

const MAX_ROOT_CHARS = 4_096;

/**
 * Lexical absolute key for lookup and revocation. Used when the directory no
 * longer exists, so `revoke` can still find an earlier grant.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function writableRootKey(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (text === '' || text.length > MAX_ROOT_CHARS || text.includes('\u0000') || !isAbsolute(text)) return '';
  return resolve(text);
}

/**
 * Validate one physical writable directory.
 *
 * `realpath` both proves existence and resolves symlinks, which DSH rejects at
 * execution time; a non-directory or unreadable path becomes null.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeWritableRoot(value) {
  const key = writableRootKey(value);
  if (key === '') return null;
  let physical;
  try {
    physical = realpathSync(key);
  } catch {
    return null;
  }
  try {
    if (!statSync(physical).isDirectory()) return null;
  } catch {
    return null;
  }
  // A filesystem root is not a "directory grant"; it is effectively full
  // write access and stays behind the explicit danger-full-access flow.
  if (isFilesystemRoot(physical)) return null;
  return physical;
}

/** Owns every runtime writable-root registration made by the attach bridge. */
export class SandboxRoots {
  #ctx;
  /** @type {Map<string, Map<string, {owners: Set<object>, dispose: (() => void)|null, error: string|null}>>} */
  #sessions = new Map();

  constructor(ctx) {
    this.#ctx = ctx;
  }

  /** The optional sandbox-policy service, or undefined on an older Host. */
  service() {
    try {
      return this.#ctx.get?.('sandboxPolicy') ?? this.#ctx.sandboxPolicy;
    } catch {
      return undefined;
    }
  }

  available() {
    const service = this.service();
    return service !== null && service !== undefined && typeof service.registerWritableRoot === 'function';
  }

  #liveSession(sessionId) {
    try {
      return this.#ctx.get?.('agents')?.get?.(String(sessionId))?.session ?? null;
    } catch {
      return null;
    }
  }

  #entries(sessionId) {
    return this.#sessions.get(String(sessionId));
  }

  /**
   * Register one directory for one Session and record the owning connection.
   *
   * @param {object} owner connection that owns this grant
   * @param {string} sessionId followed Session
   * @param {unknown} directory requested path
   * @param {object|null} [session] exact live Session, when the caller has one
   * @returns {{ok: true, directory: string, registered: boolean, pending?: true, error?: string}|{ok: false, reason: string}}
   */
  grant(owner, sessionId, directory, session = undefined) {
    if (sessionId === null || sessionId === undefined || String(sessionId) === '') return { ok: false, reason: 'no-session' };
    const service = this.service();
    if (service === null || service === undefined || typeof service.registerWritableRoot !== 'function') {
      return { ok: false, reason: 'unsupported' };
    }
    const physical = normalizeWritableRoot(directory);
    if (physical === null) return { ok: false, reason: 'invalid-root' };
    const key = String(sessionId);
    let entries = this.#sessions.get(key);
    if (entries === undefined) {
      entries = new Map();
      this.#sessions.set(key, entries);
    }
    let entry = entries.get(physical);
    if (entry === undefined) {
      entry = { owners: new Set(), dispose: null, error: null, paths: new Set([physical]) };
      entries.set(physical, entry);
    }
    // Remember the caller's spelling too, so a later revoke still works when
    // the directory (or a symlink to it) has disappeared.
    const lexical = writableRootKey(directory);
    if (lexical !== '') entry.paths.add(lexical);
    entry.owners.add(owner);
    const registered = this.#register(physical, entry, session ?? this.#liveSession(sessionId));
    return {
      ok: true,
      directory: physical,
      registered,
      ...(registered ? {} : { pending: true }),
      ...(entry.error === null ? {} : { error: entry.error }),
    };
  }

  /** Register one recorded directory unless it is already active. */
  #register(directory, entry, session) {
    if (entry.dispose !== null) return true;
    const service = this.service();
    if (service === null || service === undefined || typeof service.registerWritableRoot !== 'function') return false;
    if (session === null || session === undefined) return false;
    try {
      const dispose = service.registerWritableRoot(session, directory);
      entry.dispose = typeof dispose === 'function' ? dispose : () => {};
      entry.error = null;
      return true;
    } catch (error) {
      // `SANDBOX_INVALID_ROOT`, a race with deletion, or a symlink rejection
      // must stay local to this grant; the session keeps working.
      entry.error = typeof error?.code === 'string' ? error.code : 'sandbox/register-failed';
      return false;
    }
  }

  /**
   * Retry pending grants once the Session is live. Called when an approval
   * arrives, because the agent may have been resumed after `session.open`.
   */
  refresh(sessionId, session = undefined) {
    const entries = this.#entries(sessionId);
    if (entries === undefined) return;
    const live = session ?? this.#liveSession(sessionId);
    if (live === null || live === undefined) return;
    for (const [directory, entry] of entries) this.#register(directory, entry, live);
  }

  /** @returns {string[]} active physical directories for one Session */
  list(sessionId) {
    const entries = this.#entries(sessionId);
    if (entries === undefined) return [];
    return [...entries]
      .filter(([, entry]) => entry.dispose !== null)
      .map(([directory]) => directory)
      .sort();
  }

  /**
   * Recorded grants that are not active yet (no live Session, or the service
   * refused this attempt). They are retried by `refresh`.
   *
   * @returns {string[]}
   */
  pending(sessionId) {
    const entries = this.#entries(sessionId);
    if (entries === undefined) return [];
    return [...entries]
      .filter(([, entry]) => entry.dispose === null)
      .map(([directory]) => directory)
      .sort();
  }

  /**
   * Remove this owner's grant for one directory. Other owners keep theirs.
   *
   * @returns {{removed: boolean, directory: string}}
   */
  revoke(owner, sessionId, directory) {
    const entries = this.#entries(sessionId);
    const wanted = [normalizeWritableRoot(directory), writableRootKey(directory)].filter((value) => value !== '');
    if (entries === undefined || wanted.length === 0) return { removed: false, directory: wanted[0] ?? '' };
    for (const [key, entry] of entries) {
      const matches = wanted.some((candidate) => (
        candidate === key
        || candidate === writableRootKey(key)
        || entry.paths?.has(candidate) === true
      ));
      if (!matches) continue;
      entry.owners.delete(owner);
      if (entry.owners.size > 0) return { removed: true, directory: key };
      this.#dispose(key, entry);
      entries.delete(key);
      if (entries.size === 0) this.#sessions.delete(String(sessionId));
      return { removed: true, directory: key };
    }
    return { removed: false, directory: wanted[0] };
  }

  /** Drop every grant owned by one connection, optionally for one Session. */
  release(owner, sessionId) {
    const keys = sessionId === undefined || sessionId === null
      ? [...this.#sessions.keys()]
      : [String(sessionId)];
    for (const sessionKey of keys) {
      const entries = this.#sessions.get(sessionKey);
      if (entries === undefined) continue;
      for (const [directory, entry] of entries) {
        entry.owners.delete(owner);
        if (entry.owners.size > 0) continue;
        this.#dispose(directory, entry);
        entries.delete(directory);
      }
      if (entries.size === 0) this.#sessions.delete(sessionKey);
    }
  }

  #dispose(directory, entry) {
    const dispose = entry.dispose;
    entry.dispose = null;
    if (typeof dispose !== 'function') return;
    try {
      dispose();
    } catch {
      // The Session may already be gone; disposal must never break teardown.
    }
  }

  /** Drop every registration; used when the bridge stops. */
  clear() {
    for (const entries of this.#sessions.values()) {
      for (const [directory, entry] of entries) this.#dispose(directory, entry);
    }
    this.#sessions.clear();
  }
}
