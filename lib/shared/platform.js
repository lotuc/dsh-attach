/** Cross-platform runtime helpers shared by the Host bridge and terminal client. */
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\';

/** Whether a platform uses a Windows named pipe for the local bridge. */
export function isWindows(platform = process.platform) {
  return platform === 'win32';
}

/**
 * Choose the bridge address for the current platform.
 *
 * Unix uses a filesystem socket under the DSH home (falling back to the
 * system temp directory when the path is too long). Windows uses a named
 * pipe, because Windows does not support Unix-domain sockets through
 * `net.Server.listen(path)`.
 *
 * @param {{platform?: string, dir: string, pid?: number, tmpDir?: string, configured?: string}} options
 * @returns {string}
 */
export function bridgeSocketPath({
  platform = process.platform,
  dir,
  pid = process.pid,
  tmpDir = tmpdir(),
  configured = '',
} = {}) {
  const requested = String(configured ?? '').trim();
  if (requested !== '') return requested;
  if (isWindows(platform)) return `${WINDOWS_PIPE_PREFIX}dsh-attach-${pid}`;

  const path = join(dir, `attach-${pid}.sock`);
  if (Buffer.byteLength(path, 'utf8') <= 100) return path;
  return join(tmpDir, `dsh-attach-${pid}.sock`);
}

/** True when the bridge path is a Windows named pipe. */
export function isNamedPipePath(path) {
  return typeof path === 'string' && path.startsWith(WINDOWS_PIPE_PREFIX);
}

/** Expand a leading `~` with the platform home directory. */
export function expandHomePath(value, home = homedir()) {
  if (typeof value !== 'string' || value === '') return value;
  if (value === '~') return home;
  if (/^~[\\/]/u.test(value)) return join(home, value.slice(2));
  return value;
}

/** Signals Node can listen to on a platform, with conventional exit codes. */
export function signalSpecs(platform = process.platform) {
  const common = [
    { signal: 'SIGTERM', code: 143 },
    { signal: 'SIGINT', code: 130 },
  ];
  if (isWindows(platform)) return [...common, { signal: 'SIGBREAK', code: 149 }];
  return [
    { signal: 'SIGHUP', code: 129 },
    ...common,
    { signal: 'SIGQUIT', code: 131 },
  ];
}
