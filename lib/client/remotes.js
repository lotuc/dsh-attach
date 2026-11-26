/**
 * Named remote SSH profiles ("remote aliases").
 *
 * A single TOML file under `$DSH_HOME/dsh-attach/remotes.toml` (or the path in
 * `DSH_ATTACH_REMOTES`) maps short names to the SSH target, extra ssh argv,
 * remote executable, profile, endpoint, and cache root. Both snake_case and
 * camelCase keys are accepted on read; writes always use snake_case.
 */
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { AttachError } from './connection.js';
import { resolveDshHome } from '../shared/paths.js';
import { expandHomePath } from '../shared/platform.js';

export const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const REMOTES_DIR = 'dsh-attach';
const REMOTES_FILE = 'remotes.toml';

/** Accepted TOML keys, mapped to their camelCase in-memory name. */
const ENTRY_KEYS = {
  ssh: 'ssh',
  ssh_opts: 'sshOpts',
  sshOpts: 'sshOpts',
  remote_bin: 'remoteBin',
  remoteBin: 'remoteBin',
  profile: 'profile',
  endpoint: 'endpoint',
  cache_root: 'cacheRoot',
  cacheRoot: 'cacheRoot',
};

const OPTIONAL_STRING_KEYS = ['remoteBin', 'profile', 'endpoint', 'cacheRoot'];

function configError(path, detail) {
  return new AttachError(`remotes config ${path}: ${detail}`, 'attach/remotes-config');
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a name is usable as an alias. */
export function isValidRemoteName(name) {
  return typeof name === 'string' && REMOTE_NAME_PATTERN.test(name);
}

/**
 * Resolve the remotes TOML path.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveRemotesPath(env = process.env) {
  const configured = typeof env?.DSH_ATTACH_REMOTES === 'string' ? env.DSH_ATTACH_REMOTES.trim() : '';
  if (configured !== '') return expandHomePath(configured);
  return join(resolveDshHome(env), REMOTES_DIR, REMOTES_FILE);
}

/**
 * Validate and normalize one raw TOML table into its camelCase form.
 * Unknown keys are ignored so newer configs remain readable.
 *
 * @param {unknown} raw
 * @param {string} name
 * @param {string} path - used in error messages
 * @returns {Record<string, any>}
 */
function normalizeEntry(raw, name, path) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw configError(path, `alias "${name}" must be a table`);
  }
  const source = {};
  for (const [key, value] of Object.entries(raw)) {
    const mapped = ENTRY_KEYS[key];
    if (mapped !== undefined) source[mapped] = value;
  }

  if (typeof source.ssh !== 'string' || source.ssh.trim() === '') {
    throw configError(path, `alias "${name}" needs a non-empty ssh target`);
  }
  const entry = { ssh: source.ssh.trim() };

  if (source.sshOpts !== undefined) {
    if (!Array.isArray(source.sshOpts)) {
      throw configError(path, `alias "${name}" ssh_opts must be an array of strings`);
    }
    entry.sshOpts = source.sshOpts.map((value) => {
      if (typeof value !== 'string' || value.trim() === '') {
        throw configError(path, `alias "${name}" ssh_opts must be an array of strings`);
      }
      return value;
    });
  }

  for (const key of OPTIONAL_STRING_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw configError(path, `alias "${name}" ${key} must be a non-empty string`);
    }
    entry[key] = value.trim();
  }
  return entry;
}

/**
 * Parse TOML text into a map of alias name -> normalized entry.
 * @param {string} text
 * @param {string} [path]
 * @returns {Record<string, Record<string, any>>}
 */
export function parseRemotesText(text, path = 'remotes.toml') {
  let document;
  try {
    document = parseToml(text);
  } catch (error) {
    throw configError(path, messageOf(error));
  }
  const table = document?.remotes;
  if (table === undefined) return {};
  if (table === null || typeof table !== 'object' || Array.isArray(table)) {
    throw configError(path, '"remotes" must be a table');
  }
  const remotes = {};
  for (const [name, raw] of Object.entries(table)) {
    if (!isValidRemoteName(name)) {
      throw configError(
        path,
        `invalid alias name ${JSON.stringify(name)} (use letters, digits, ".", "_", "-"; max 64; must start alphanumeric)`,
      );
    }
    remotes[name] = normalizeEntry(raw, name, path);
  }
  return remotes;
}

/**
 * Read the remotes file. A missing file is not an error.
 * @param {string} [path]
 * @returns {Promise<Record<string, Record<string, any>>>}
 */
export async function loadRemotes(path = resolveRemotesPath()) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw configError(path, messageOf(error));
  }
  return parseRemotesText(text, path);
}

/**
 * Synchronous variant for CLI option normalization, which stays synchronous.
 * @param {string} [path]
 * @returns {Record<string, Record<string, any>>}
 */
export function loadRemotesSync(path = resolveRemotesPath()) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw configError(path, messageOf(error));
  }
  return parseRemotesText(text, path);
}

/** Serialize a remotes map as clean snake_case TOML. */
function serializeRemotes(remotes) {
  if (remotes === null || typeof remotes !== 'object' || Array.isArray(remotes)) {
    throw new AttachError('remotes must be an object keyed by alias name', 'attach/remotes-config');
  }
  const document = { remotes: {} };
  for (const name of Object.keys(remotes).sort()) {
    if (!isValidRemoteName(name)) {
      throw new AttachError(
        `invalid remote alias name ${JSON.stringify(name)} (use letters, digits, ".", "_", "-"; max 64; must start alphanumeric)`,
        'attach/remotes-config',
      );
    }
    const entry = normalizeEntry(remotes[name], name, 'remotes.toml');
    const table = { ssh: entry.ssh };
    if (Array.isArray(entry.sshOpts) && entry.sshOpts.length > 0) table.ssh_opts = entry.sshOpts;
    if (entry.remoteBin !== undefined) table.remote_bin = entry.remoteBin;
    if (entry.profile !== undefined) table.profile = entry.profile;
    if (entry.endpoint !== undefined) table.endpoint = entry.endpoint;
    if (entry.cacheRoot !== undefined) table.cache_root = entry.cacheRoot;
    document.remotes[name] = table;
  }
  return `${stringifyToml(document).replace(/\n+$/u, '')}\n`;
}

/** Create the parent directory with owner-only permissions when possible. */
async function ensureParentDir(dir) {
  let existed = true;
  try {
    await stat(dir);
  } catch {
    existed = false;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!existed && process.platform !== 'win32') {
    await chmod(dir, 0o700).catch(() => {});
  }
}

/**
 * Atomically replace the remotes file, using mode 0600 on Unix.
 * @param {string} path
 * @param {Record<string, Record<string, any>>} remotes
 */
export async function saveRemotes(path, remotes) {
  const payload = serializeRemotes(remotes);
  const dir = dirname(path);
  try {
    await ensureParentDir(dir);
    const temporary = join(
      dir,
      `.${basename(path)}.${process.pid}.${Date.now().toString(36)}.tmp`,
    );
    try {
      await writeFile(temporary, payload, { mode: 0o600 });
      if (process.platform !== 'win32') await chmod(temporary, 0o600).catch(() => {});
      await rename(temporary, path).catch(async (error) => {
        if (process.platform === 'win32' && ['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) {
          await unlink(path).catch(() => {});
          await rename(temporary, path);
          return;
        }
        throw error;
      });
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  } catch (error) {
    if (error instanceof AttachError) throw error;
    throw configError(path, messageOf(error));
  }
}

/**
 * Look up one alias and return its normalized, fully shaped entry.
 * Invalid or unknown aliases return null so callers can fall back to a literal
 * SSH target.
 *
 * @param {string} name
 * @param {Record<string, any>|null|undefined} remotes
 * @returns {{name: string, ssh: string, sshOpts: string[], remoteBin: string|undefined,
 *   profile: string|undefined, endpoint: string|undefined, cacheRoot: string|undefined}|null}
 */
export function resolveRemoteAlias(name, remotes) {
  if (!isValidRemoteName(name)) return null;
  if (remotes === null || typeof remotes !== 'object' || Array.isArray(remotes)) return null;
  if (!Object.hasOwn(remotes, name)) return null;
  let entry;
  try {
    entry = normalizeEntry(remotes[name], name, 'remotes.toml');
  } catch {
    return null;
  }
  return {
    name,
    ssh: entry.ssh,
    sshOpts: entry.sshOpts ?? [],
    remoteBin: entry.remoteBin,
    profile: entry.profile,
    endpoint: entry.endpoint,
    cacheRoot: entry.cacheRoot,
  };
}

/**
 * Merge CLI overrides into one resolved alias.
 *
 * Scalar CLI fields win when present; CLI ssh options are appended after the
 * alias options so ad-hoc flags (for example a one-off `-v`) still apply.
 *
 * @param {{ssh: string, sshOpts?: string[], remoteBin?: string, profile?: string,
 *   endpoint?: string, cacheRoot?: string}} alias
 * @param {Record<string, any>} [cliOptions]
 */
export function mergeRemoteOptions(alias, cliOptions = {}) {
  const cli = cliOptions ?? {};
  const scalar = (key) => (cli[key] !== undefined && cli[key] !== null ? cli[key] : alias[key]);
  return {
    ssh: alias.ssh,
    sshOpts: [
      ...(Array.isArray(alias.sshOpts) ? alias.sshOpts : []),
      ...(Array.isArray(cli.sshOpts) ? cli.sshOpts : []),
    ],
    remoteBin: scalar('remoteBin'),
    profile: scalar('profile'),
    endpoint: scalar('endpoint'),
    cacheRoot: scalar('cacheRoot'),
  };
}
