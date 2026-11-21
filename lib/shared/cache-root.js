/**
 * Single owner of the optional agent cache root.
 *
 * The client resolves `--cache-root` at launch and sends the result (or the
 * `@session` token) on `session.open`. This module owns the whole policy:
 * `resolveCacheRoot` is the only function that turns `@cwd`/`@session` into a
 * path and appends the cache directory name; it always returns an absolute
 * path or null. `resolveCacheRootOption` is the client entry point that
 * validates the raw option and forwards an unresolved `@session` token to the
 * Host. `cacheEnvForRoot` consumes only a resolved path, so the shell bridge is
 * a pure derivation that needs no cwd.
 */
import { isAbsolute, join, resolve } from 'node:path';

export const CACHE_ROOT_SESSION = '@session';
export const CACHE_ROOT_CWD = '@cwd';

const CACHE_DIR_NAME = '.cache';
const MAX_CACHE_ROOT_CHARS = 4_096;

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

/** A cwd is usable only when it is already absolute; never resolve against the process cwd. */
function absoluteDir(value) {
  return isNonEmptyString(value) && isAbsolute(value) ? value : null;
}

/** Validate a raw cache root; anything malformed becomes null, never throws. */
export function normalizeCacheRoot(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === '' || text.length > MAX_CACHE_ROOT_CHARS || text.includes('\u0000')) return null;
  return text;
}

/**
 * Resolve one cache-root input to an absolute directory, or null when it is
 * disabled, malformed, or needs a cwd that the caller does not have.
 *
 * `@cwd` uses `launchCwd` (the terminal that launched the client) and
 * `@session` uses `sessionCwd` (the immutable Session workspace root). Explicit
 * absolute roots pass through untouched; explicit relative roots need
 * `launchCwd`. Callers must not guess a cwd to make a token resolve.
 *
 * @param {unknown} value
 * @param {{launchCwd?: string, sessionCwd?: string}} [context]
 * @returns {string|null}
 */
export function resolveCacheRoot(value, { launchCwd, sessionCwd } = {}) {
  const text = normalizeCacheRoot(value);
  if (text === null) return null;
  if (text === CACHE_ROOT_SESSION) {
    const base = absoluteDir(sessionCwd);
    return base === null ? null : join(base, CACHE_DIR_NAME);
  }
  if (text === CACHE_ROOT_CWD) {
    const base = absoluteDir(launchCwd);
    return base === null ? null : join(base, CACHE_DIR_NAME);
  }
  if (isAbsolute(text)) return text;
  const base = absoluteDir(launchCwd);
  return base === null ? null : resolve(base, text);
}

/** Client-side `--cache-root` entry point; invalid values throw for the CLI. */
export function resolveCacheRootOption(value, cwd = process.cwd()) {
  const text = normalizeCacheRoot(value);
  if (text === null) {
    if (String(value ?? '').trim() === '') return null;
    throw new Error('cache root is invalid');
  }
  // The Host alone knows the Session cwd, so the token crosses the wire as-is.
  if (text === CACHE_ROOT_SESSION) return CACHE_ROOT_SESSION;
  const root = resolveCacheRoot(text, { launchCwd: cwd });
  if (root === null) throw new Error('cache root is invalid');
  return root;
}

/**
 * Whether an explicit cache root was requested but the Host disabled it.
 *
 * `opened` is the `session.open` result. A superseded or disposed open reports
 * `applied: false`: its `cacheRoot` only records what that attempt resolved, so
 * it must not produce the user-facing notice.
 *
 * @param {{applied?: boolean, cacheRoot?: string|null}|undefined|null} opened
 * @param {boolean} requested
 * @returns {boolean}
 */
export function cacheRootNotApplied(opened, requested) {
  return requested === true && opened?.applied !== false && opened?.cacheRoot === null;
}

/**
 * Build cache environment variables for one shell request.
 *
 * The root must already be an absolute directory resolved by
 * `resolveCacheRoot`; relative paths and `@session` are rejected here. Existing
 * `MAVEN_ARGS` is preserved by appending the repository property.
 *
 * @param {string} root
 * @param {Record<string, string>} [baseEnv]
 * @returns {Record<string, string>}
 */
export function cacheEnvForRoot(root, baseEnv = {}) {
  const cache = normalizeCacheRoot(root);
  if (cache === null || !isAbsolute(cache)) return {};
  const mavenRepo = `-Dmaven.repo.local=${join(cache, 'm2', 'repository')}`;
  const existingMavenArgs = typeof baseEnv?.MAVEN_ARGS === 'string' ? baseEnv.MAVEN_ARGS.trim() : '';
  return {
    CLJ_CACHE: join(cache, 'clojure', 'cpcache'),
    GITLIBS: join(cache, 'clojure', 'gitlibs'),
    GRADLE_USER_HOME: join(cache, 'gradle'),
    LEIN_HOME: join(cache, 'lein'),
    COURSIER_CACHE: join(cache, 'coursier'),
    PIP_CACHE_DIR: join(cache, 'pip'),
    npm_config_cache: join(cache, 'npm'),
    CARGO_HOME: join(cache, 'cargo'),
    GOMODCACHE: join(cache, 'go', 'mod'),
    GOCACHE: join(cache, 'go', 'build'),
    MAVEN_ARGS: existingMavenArgs === '' ? mavenRepo : `${existingMavenArgs} ${mavenRepo}`,
  };
}
