/**
 * Start DeepSeek Harness when no attach endpoint exists, then wait for its
 * bridge. This is only used for descriptor discovery: explicit endpoints and
 * sockets never trigger a launch.
 */
import { spawn as spawnProcess } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';

import { AttachError } from './connection.js';

/** A cold DSH start includes Electron, plugin composition, and session load. */
export const START_TIMEOUT_MS = 120_000;
export const START_POLL_MS = 500;

const MAC_APP = '/Applications/DeepSeek Harness.app';
const WINDOWS_APP_DIR = 'DeepSeek Harness';
const WINDOWS_APP_EXE = 'DeepSeek Harness.exe';
const TRANSIENT = new Set(['attach/no-endpoint', 'attach/unreachable', 'attach/timeout']);

function executable(path, platform) {
  try {
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name, env, platform) {
  const directories = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':');
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const directory of directories) {
    if (directory === '') continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (executable(candidate, platform)) return candidate;
    }
  }
  return null;
}

function windowsApp(env, exists) {
  const roots = [
    env.LOCALAPPDATA === undefined ? null : join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'),
    env.ProgramFiles === undefined ? null : join(env.ProgramFiles, 'DeepSeek Harness'),
    env['ProgramFiles(x86)'] === undefined ? null : join(env['ProgramFiles(x86)'], 'DeepSeek Harness'),
  ];
  for (const root of roots) {
    if (root === null) continue;
    const path = join(root, WINDOWS_APP_DIR, WINDOWS_APP_EXE);
    if (exists(path)) return path;
  }
  return null;
}

/**
 * Resolve how to start DSH for the requested profile.
 * @param {{profile?: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv,
 *   exists?: (path: string) => boolean, findExecutable?: (name: string, env: NodeJS.ProcessEnv,
 *   platform: NodeJS.Platform) => string | null}} [options]
 * @returns {{command: string, args: string[], label: string, shell?: boolean} | null}
 */
export function resolveHostLaunch({
  profile,
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  findExecutable = onPath,
} = {}) {
  const desktop = profile === undefined || profile === 'desktop';
  if (desktop && platform === 'darwin') {
    const apps = [
      MAC_APP,
      env.HOME === undefined ? null : join(env.HOME, 'Applications', 'DeepSeek Harness.app'),
    ];
    const app = apps.find((path) => path !== null && exists(path));
    if (app !== undefined && app !== null) {
      return { command: 'open', args: [app], label: 'DeepSeek Harness' };
    }
  }
  if (desktop && platform === 'win32') {
    const app = windowsApp(env, exists);
    if (app !== null) return { command: app, args: [], label: 'DeepSeek Harness' };
  }
  if (profile === 'desktop') return null;

  const dsh = findExecutable('dsh', env, platform);
  if (dsh === null) return null;
  const name = profile ?? 'web';
  return {
    command: dsh,
    args: [name],
    label: `DeepSeek Harness (${name})`,
    shell: platform === 'win32' && /\.(?:cmd|bat)$/iu.test(dsh),
  };
}

/**
 * Spawn a detached launcher. The child must outlive this terminal, so it is
 * unref'ed and keeps no stdio pipes.
 * @param {{command: string, args: string[], shell?: boolean}} launch
 * @param {{spawn?: typeof spawnProcess, env?: NodeJS.ProcessEnv}} [options]
 */
export async function launchHost(launch, { spawn = spawnProcess, env = process.env } = {}) {
  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(launch.command, launch.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: launch.shell === true,
        env,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Connect, starting DSH once when discovery finds no endpoint.
 * @param {import('./connection.js').AttachClient} client
 * @param {{endpoint?: string, socketPath?: string, token?: string, profile?: string,
 *   timeoutMs?: number}} connectOptions
 * @param {{autoStart?: boolean, launch?: ReturnType<typeof resolveHostLaunch>,
 *   start?: typeof launchHost, timeoutMs?: number, pollMs?: number,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>,
 *   onLaunch?: (launch: Exclude<ReturnType<typeof resolveHostLaunch>, null>) => void,
 *   onWait?: (timeoutMs: number) => void}} [options]
 * @returns {Promise<Exclude<ReturnType<typeof resolveHostLaunch>, null> | null>}
 */
export async function connectWithAutostart(client, connectOptions = {}, {
  autoStart = true,
  launch,
  start = launchHost,
  timeoutMs = START_TIMEOUT_MS,
  pollMs = START_POLL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onLaunch,
  onWait,
} = {}) {
  let initial;
  try {
    await client.connect(connectOptions);
    return null;
  } catch (error) {
    initial = error;
  }

  if (
    !autoStart ||
    connectOptions.endpoint !== undefined ||
    connectOptions.socketPath !== undefined ||
    initial?.code !== 'attach/no-endpoint'
  ) {
    throw initial;
  }

  const resolved = launch === undefined
    ? resolveHostLaunch({ profile: connectOptions.profile })
    : launch;
  if (resolved === null) throw initial;

  onLaunch?.(resolved);
  try {
    await start(resolved);
  } catch (error) {
    throw new AttachError(
      `could not start ${resolved.label}: ${error instanceof Error ? error.message : String(error)}`,
      'attach/start-failed',
    );
  }

  onWait?.(timeoutMs);
  const deadline = now() + timeoutMs;
  let last = initial;
  while (now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    if (now() >= deadline) break;
    try {
      await client.connect(connectOptions);
      return resolved;
    } catch (error) {
      if (!TRANSIENT.has(error?.code)) throw error;
      last = error;
    }
  }

  throw new AttachError(
    `started ${resolved.label} but no attach endpoint appeared within ${Math.round(timeoutMs / 1000)}s. ` +
      `Check that dsh-attach is installed in that profile. Last error: ${last instanceof Error ? last.message : String(last)}`,
    'attach/start-timeout',
  );
}
