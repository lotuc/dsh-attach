/**
 * Resolve the optional agent cache root and derive the environment variables
 * that keep common language-tool caches inside it.
 *
 * `@cwd` is resolved by the client at launch time; `@session` is resolved by
 * the Host against the immutable Session workspace root, so switching
 * sessions does not reuse another workspace's cache.
 */
import { isAbsolute, join, resolve } from 'node:path';

export const CACHE_ROOT_SESSION = '@session';
export const CACHE_ROOT_CWD = '@cwd';

const MAX_CACHE_ROOT_CHARS = 4_096;

/** Resolve a client-side `--cache-root` value to what `session.open` sends. */
export function resolveCacheRootOption(value, cwd = process.cwd()) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  if (text.length > MAX_CACHE_ROOT_CHARS || text.includes('\u0000')) {
    throw new Error('cache root is invalid');
  }
  if (text === CACHE_ROOT_SESSION) return CACHE_ROOT_SESSION;
  if (text === CACHE_ROOT_CWD) return join(cwd, '.cache');
  return resolve(cwd, text);
}

/** Validate a cache root received from a client; null means disabled. */
export function normalizeCacheRoot(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === '' || text.length > MAX_CACHE_ROOT_CHARS || text.includes('\u0000')) return null;
  return text;
}

/**
 * Build cache environment variables for one shell request.
 *
 * The root is a directory under which tool-specific cache directories are
 * created. `@session` resolves to `<session cwd>/.cache`. Existing
 * `MAVEN_ARGS` is preserved by appending the repository property.
 *
 * @param {string} root
 * @param {string} cwd
 * @param {Record<string, string>} [baseEnv]
 * @returns {Record<string, string>}
 */
export function cacheEnvForRoot(root, cwd, baseEnv = {}) {
  const normalized = normalizeCacheRoot(root);
  if (normalized === null) return {};
  if (normalized === CACHE_ROOT_SESSION && (typeof cwd !== 'string' || cwd === '')) return {};
  const baseCwd = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
  const cache = normalized === CACHE_ROOT_SESSION
    ? join(baseCwd, '.cache')
    : (isAbsolute(normalized) ? normalized : resolve(baseCwd, normalized));
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
