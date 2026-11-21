/**
 * Session-scoped environment bridge for model shell calls.
 *
 * One connection follows at most one Session, so this module keeps exactly one
 * env entry per connection: opening another Session replaces the entry instead
 * of accumulating dead state. Across connections the merge policy is fixed:
 * the newest non-empty Herdr env and the newest non-null cache root are chosen
 * independently, so the two facts cannot erase each other (a terminal that only
 * forwards Herdr facts keeps another terminal's cache root, and a terminal that
 * only forwards a cache root keeps another terminal's Herdr env).
 *
 * The module owns the whole shell.resolve monkey-patch: `install` patches once,
 * `restore` puts the original resolver back, and both tolerate a replaced or
 * frozen shell service. `clear` drops all connection state.
 */
import { cacheEnvForRoot } from '../shared/cache-root.js';
import { herdrEnvFromClient, mergeShellEnv } from './shell-env.js';

export class SessionEnv {
  #ctx;
  /** @type {Map<object, {sessionId: string, env: Record<string, string>, cacheRoot: string|null, at: number}>} */
  #entries = new Map();
  /** Monotonic recency for the cross-connection merge. */
  #clock = 0;
  #shell = null;
  #original = null;
  #wrapper = null;

  constructor(ctx) {
    this.#ctx = ctx;
  }

  /**
   * Replace this connection's environment with the one it now follows.
   * An empty environment with no cache root removes the entry, so a plain
   * session switch cannot leave stale facts behind. An entry that only carries
   * a cache root is kept: its root still participates in the merge.
   *
   * @param {object} conn
   * @param {string} sessionId
   * @param {unknown} value
   * @param {string|null} cacheRoot resolved absolute root, or null
   */
  set(conn, sessionId, value, cacheRoot) {
    if (sessionId === null || sessionId === undefined || String(sessionId) === '') return;
    const env = herdrEnvFromClient(value);
    const root = typeof cacheRoot === 'string' && cacheRoot !== '' ? cacheRoot : null;
    if (Object.keys(env).length === 0 && root === null) {
      this.#entries.delete(conn);
      return;
    }
    this.#entries.set(conn, { sessionId: String(sessionId), env, cacheRoot: root, at: ++this.#clock });
    this.install();
  }

  /**
   * Remove one Session's entry, or every entry owned by this connection.
   *
   * @param {object} conn
   * @param {string|null} [sessionId] omit to clear the whole connection
   */
  remove(conn, sessionId) {
    if (sessionId === undefined || sessionId === null) {
      this.#entries.delete(conn);
      return;
    }
    const entry = this.#entries.get(conn);
    if (entry !== undefined && entry.sessionId === String(sessionId)) this.#entries.delete(conn);
  }

  /**
   * Merge every connection following one Session. The newest non-empty env and
   * the newest non-null cache root are selected separately; an entry that only
   * has one of them never blanks the other. Both absent means no entry.
   *
   * @param {string} sessionId
   * @returns {{env: Record<string, string>, cacheRoot: string|null}|undefined}
   */
  envFor(sessionId) {
    const key = String(sessionId);
    let envEntry;
    let cacheEntry;
    for (const entry of this.#entries.values()) {
      if (entry.sessionId !== key) continue;
      if (Object.keys(entry.env).length > 0 && (envEntry === undefined || entry.at > envEntry.at)) envEntry = entry;
      if (entry.cacheRoot !== null && (cacheEntry === undefined || entry.at > cacheEntry.at)) cacheEntry = entry;
    }
    if (envEntry === undefined && cacheEntry === undefined) return undefined;
    return { env: envEntry?.env ?? {}, cacheRoot: cacheEntry?.cacheRoot ?? null };
  }

  /** Patch shell.resolve once; a missing or frozen shell leaves install retryable. */
  install() {
    if (this.#shell !== null) return;
    const shell = this.#ctx.get('shell') ?? this.#ctx.shell;
    if (shell === undefined || shell === null || typeof shell.resolve !== 'function') return;
    const original = shell.resolve.bind(shell);
    const wrapper = (request) => {
      const sessionId = typeof request?.dshEnv?.DSH_SESSION_ID === 'string' ? request.dshEnv.DSH_SESSION_ID : '';
      const entry = this.envFor(sessionId);
      if (entry === undefined) return original(request);
      const cacheEnv = cacheEnvForRoot(entry.cacheRoot, request?.env);
      return original(mergeShellEnv(request, { ...entry.env, ...cacheEnv }));
    };
    try {
      shell.resolve = wrapper;
    } catch {
      return;
    }
    this.#shell = shell;
    this.#original = original;
    this.#wrapper = wrapper;
  }

  /** Put the original resolver back unless the service was replaced or frozen. */
  restore() {
    if (this.#shell === null) return;
    try {
      if (this.#shell.resolve === this.#wrapper) this.#shell.resolve = this.#original;
    } catch {
      // A replaced/frozen shell service is left alone.
    }
    this.#shell = null;
    this.#original = null;
    this.#wrapper = null;
  }

  /** Drop all connection environment. */
  clear() {
    this.#entries.clear();
  }
}
