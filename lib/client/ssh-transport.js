/**
 * SSH transport for attaching to a remote DeepSeek Harness without opening a
 * listener on the remote Host.
 *
 * The local client spawns `ssh -T <target> -- <remote dsh-attach> --stdio-proxy`
 * and treats the child's stdout/stdin as a byte stream. NDJSON frames are
 * unchanged across the hop; the remote proxy discovers `endpoint.json` and
 * injects the rotated token into the opening `hello` frame, so the token never
 * leaves the remote host.
 *
 * This module also owns SSH failure classification so callers can distinguish
 * retryable network failures from actionable, non-retryable ones (bad
 * credentials, missing remote binary, protocol mismatch).
 */
import { spawn as spawnProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { AttachError } from './connection.js';

/** Keepalive and connect timeout options every SSH attach uses. */
export const SSH_KEEPALIVE_ARGS = Object.freeze([
  '-o',
  'ServerAliveInterval=10',
  '-o',
  'ServerAliveCountMax=3',
  '-o',
  'ConnectTimeout=10',
]);

/** Handshake budget for an SSH attach (network hop + remote dial). */
export const SSH_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Stable non-retryable failures. Retrying these would only repeat the same
 * error, so the TUI stops its automatic reconnect loop and shows a hint.
 */
export const FATAL_SSH_ERROR_CODES = Object.freeze(new Set([
  'attach/ssh-auth',
  'attach/ssh-remote-bin',
  'attach/ssh-failed',
  'attach/stdio-proxy',
  'attach/unauthorized',
]));

/** Failures worth retrying because a network hop or Host restart caused them. */
export const RETRYABLE_ATTACH_CODES = Object.freeze(new Set([
  'attach/unreachable',
  'attach/timeout',
  'attach/closed',
  'attach/no-endpoint',
]));

/**
 * Whether a classified error should stop automatic reconnects.
 * @param {unknown} code
 * @returns {boolean}
 */
export function isFatalSshCode(code) {
  return typeof code === 'string' && FATAL_SSH_ERROR_CODES.has(code);
}

/**
 * Whether an error is a transient connection failure.
 * @param {unknown} code
 * @returns {boolean}
 */
export function isRetryableAttachCode(code) {
  return typeof code === 'string' && RETRYABLE_ATTACH_CODES.has(code);
}

/** POSIX-quote one argument for the remote shell command line. */
export function posixQuote(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`;
}

/**
 * Windows `cmd.exe` / PowerShell-safe token quoting.
 *
 * Windows OpenSSH may run the remote command through either `cmd.exe` or
 * PowerShell. PowerShell treats a leading quoted string (`"C:\...\foo.cmd"`)
 * as a string expression rather than a command unless `&` is used, whereas
 * `cmd.exe` rejects `&`. Leaving plain tokens unquoted (and normalizing `/` to
 * `\` in the executable path) works identically in both `cmd.exe` and
 * PowerShell.
 */
const SAFE_WINDOWS_TOKEN = /^[A-Za-z0-9._:\\/@+-]+$/u;

export function cmdQuote(value) {
  const text = String(value);
  if (SAFE_WINDOWS_TOKEN.test(text)) return text;
  return `"${text.replace(/"/gu, '""')}"`;
}

/** Whether an explicit `--remote-bin` looks like a Windows path. */
function isWindowsRemotePath(value) {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || /\.(?:cmd|bat|exe)$/iu.test(value);
}

/**
 * Build the remote executable reference. A leading `~/` is expanded by the
 * remote shell; everything else is quoted so spaces and metacharacters survive
 * both the local spawn and the remote shell.
 * @param {string} remoteBin
 */
function remoteBinReference(remoteBin) {
  const text = String(remoteBin);
  if (text === '~') return '"$HOME"';
  if (text.startsWith('~/')) return `"$HOME"/${posixQuote(text.slice(2))}`;
  return posixQuote(text);
}

/**
 * Build the remote shell command that runs `--stdio-proxy`.
 *
 * Without `--remote-bin` the command probes the executable on `PATH`, then the
 * conventional local bin directory, then every profile's `.bin` directory. The
 * first match `exec`s so the SSH exit status is the proxy's status. A 127 exit
 * with the explicit marker on stderr lets the local classifier report a missing
 * remote binary rather than a generic SSH failure.
 *
 * @param {{profile?: string, endpoint?: string, remoteBin?: string}} [options]
 * @returns {string}
 */
export function buildRemoteCommand({ profile, endpoint, remoteBin } = {}) {
  const forwarded = ['--stdio-proxy'];
  if (typeof profile === 'string' && profile !== '') forwarded.push('--profile', profile);
  if (typeof endpoint === 'string' && endpoint !== '') forwarded.push('--endpoint', endpoint);
  const args = forwarded.map(posixQuote).join(' ');

  if (typeof remoteBin === 'string' && remoteBin !== '') {
    // A Windows remote path cannot use `exec` or POSIX single quotes.
    // Normalize `/` to `\` on the executable path so both cmd.exe and
    // PowerShell accept it without quoting when there are no spaces.
    if (isWindowsRemotePath(remoteBin)) {
      const normalizedBin = remoteBin.replace(/\//gu, '\\');
      const windowsArgs = forwarded.map(cmdQuote).join(' ');
      return `${cmdQuote(normalizedBin)} ${windowsArgs}`;
    }
    return `exec ${remoteBinReference(remoteBin)} ${args}`;
  }

  // The probe is POSIX shell. On a Windows remote, pass --remote-bin explicitly
  // (and make sure the SSH login shell can run it, e.g. cmd.exe with a `.cmd`).
  const missing = 'dsh-attach: remote dsh-attach not found; install it in that profile or pass --remote-bin';
  return [
    'for candidate in dsh-attach "$HOME"/.local/bin/dsh-attach "$HOME"/.dsh/profiles/*/node_modules/.bin/dsh-attach; do',
    '  if command -v "$candidate" >/dev/null 2>&1; then',
    `    exec "$candidate" ${args}`,
    '  fi',
    'done',
    `printf '%s\\n' ${posixQuote(missing)} >&2`,
    'exit 127',
  ].join('\n');
}

/**
 * Build the local `ssh` invocation.
 *
 * `-T` is mandatory: the TUI owns the local terminal and the remote command is
 * a byte proxy, not an interactive shell. Keepalives detect half-open links.
 *
 * @param {{target: string, profile?: string, endpoint?: string,
 *   remoteBin?: string, sshOpts?: string[], batchMode?: boolean}} options
 * @returns {{command: string, args: string[], remoteCommand: string, target: string}}
 */
export function buildSshCommand({
  target,
  profile,
  endpoint,
  remoteBin,
  sshOpts = [],
  batchMode = false,
} = {}) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new AttachError('--ssh needs a target (user@host or an ssh alias)', 'attach/ssh-failed');
  }
  if (!Array.isArray(sshOpts)) {
    throw new AttachError('sshOpts must be an array of strings', 'attach/ssh-failed');
  }
  for (const option of sshOpts) {
    if (typeof option !== 'string' || option === '') {
      throw new AttachError('--ssh-opt needs a non-empty argument', 'attach/ssh-failed');
    }
  }
  const normalizedTarget = target.trim();
  const args = ['-T', ...SSH_KEEPALIVE_ARGS];
  if (batchMode === true) args.push('-o', 'BatchMode=yes');
  args.push(...sshOpts);
  const remoteCommand = buildRemoteCommand({ profile, endpoint, remoteBin });
  args.push(normalizedTarget, remoteCommand);
  return { command: 'ssh', args, remoteCommand, target: normalizedTarget };
}

const AUTH_PATTERN = /Permission denied|Host key verification failed|Too many authentication failures|Authentication failed|no supported authentication methods/iu;
const REMOTE_BIN_PATTERN = /dsh-attach: remote dsh-attach not found|(?:^|\n)(?:[^\n]*: )?dsh-attach: (?:command )?not found/iu;
const PROTOCOL_PATTERN = /protocol mismatch|speaks protocol|unsupported protocol|unexpected protocol|protocol version/iu;
const TIMEOUT_PATTERN = /timed out|timeout/iu;
const UNREACHABLE_PATTERN = /Connection refused|No route to host|Network is unreachable|Connection reset|Broken pipe|Connection closed by|kex_exchange_identification|ssh_exchange_identification|Could not resolve hostname|Name or service not known|Temporary failure in name resolution/iu;

/**
 * Classify one SSH child failure.
 *
 * The returned object is an `AttachError` with a stable `code` plus
 * `retryable` and `stderr` fields. Unknown failures are treated as
 * non-retryable so the TUI shows the SSH diagnostic instead of looping.
 *
 * @param {{stderr?: string, exitCode?: number|null, target?: string}} [failure]
 * @returns {AttachError & {retryable: boolean, stderr: string}}
 */
export function classifySshError({ stderr = '', exitCode = null, target = '' } = {}) {
  const text = String(stderr ?? '').replace(/\r\n/gu, '\n').trim();
  const detail = text === '' ? '' : `: ${text.split('\n').filter((line) => line.trim() !== '').slice(-3).join(' ')}`;
  const destination = target === '' ? 'Remote SSH' : `SSH to ${target}`;

  const make = (code, message, retryable) => {
    const error = new AttachError(message, code);
    error.retryable = retryable;
    error.stderr = text;
    return error;
  };

  if (AUTH_PATTERN.test(text)) {
    return make('attach/ssh-auth', `${destination} authentication failed${detail}`, false);
  }
  if (exitCode === 127 || REMOTE_BIN_PATTERN.test(text)) {
    return make(
      'attach/ssh-remote-bin',
      `${destination} could not find dsh-attach; install it in that profile or pass --remote-bin${detail}`,
      false,
    );
  }
  if (PROTOCOL_PATTERN.test(text)) {
    return make('attach/ssh-failed', `${destination} protocol mismatch${detail}`, false);
  }
  if (TIMEOUT_PATTERN.test(text)) {
    return make('attach/timeout', `${destination} timed out${detail}`, true);
  }
  if (UNREACHABLE_PATTERN.test(text)) {
    return make('attach/unreachable', `${destination} is unreachable${detail}`, true);
  }
  if (exitCode === 0 || exitCode === null) {
    return make('attach/closed', `${destination} closed before the Host handshake completed${detail}`, true);
  }
  return make(
    'attach/ssh-failed',
    `${destination} failed (ssh exit ${String(exitCode)})${detail}`,
    false,
  );
}

/**
 * Stream adapter that presents an SSH child process with the small socket-like
 * surface `AttachClient` needs.
 */
export class SshTransport extends EventEmitter {
  #child;
  #target;
  #closed = false;
  #stderr = '';
  #stderrLimit;

  constructor(child, { target = '', stderrLimit = 64 * 1024 } = {}) {
    super();
    this.#child = child;
    this.#target = target;
    this.#stderrLimit = stderrLimit;
    const stdout = child.stdout;
    const stderr = child.stderr;
    const stdin = child.stdin;
    stdout?.setEncoding?.('utf8');
    stdout?.on?.('data', (chunk) => this.emit('data', chunk));
    stdout?.on?.('error', () => {});
    stderr?.setEncoding?.('utf8');
    stderr?.on?.('data', (chunk) => {
      this.#stderr += chunk;
      if (this.#stderr.length > this.#stderrLimit) {
        this.#stderr = this.#stderr.slice(-this.#stderrLimit);
      }
    });
    stderr?.on?.('error', () => {});
    stdin?.on?.('error', (cause) => {
      if (this.#closed) return;
      const error = new AttachError(
        `SSH stdin failed${cause?.message === undefined ? '' : `: ${cause.message}`}`,
        'attach/closed',
      );
      error.retryable = true;
      this.emit('error', error);
    });
    child.on('error', (cause) => {
      const error = new AttachError(
        `cannot run ssh${cause?.message === undefined ? '' : `: ${cause.message}`}`,
        'attach/ssh-failed',
      );
      error.retryable = false;
      error.stderr = this.#stderr;
      this.emit('error', error);
      this.#finish(null, null, error);
    });
    child.on('close', (exitCode, signal) => this.#finish(exitCode, signal));
  }

  /** Compatibility with the `net.Socket` surface used by AttachClient. */
  setEncoding() {}

  /** Compatibility with the `net.Socket` surface used by AttachClient. */
  setNoDelay() {}

  write(data) {
    if (this.#closed) return false;
    try {
      return this.#child.stdin?.write?.(data) ?? false;
    } catch (cause) {
      const error = new AttachError(
        `cannot write to ssh${cause?.message === undefined ? '' : `: ${cause.message}`}`,
        'attach/closed',
      );
      error.retryable = true;
      queueMicrotask(() => this.emit('error', error));
      return false;
    }
  }

  end() {
    try {
      this.#child.stdin?.end?.();
    } catch {
      // The child may already be gone.
    }
  }

  destroy() {
    if (this.#closed) return;
    this.#closed = true;
    for (const stream of [this.#child.stdin, this.#child.stdout, this.#child.stderr]) {
      try {
        stream?.destroy?.();
      } catch {
        // Best effort.
      }
    }
    try {
      this.#child.kill?.('SIGTERM');
    } catch {
      // Best effort.
    }
  }

  #finish(exitCode, signal, existing = null) {
    if (this.#closed) return;
    this.#closed = true;
    if (existing !== null) {
      this.emit('close', existing);
      return;
    }
    if (exitCode === 0 && (signal === null || signal === undefined)) {
      this.emit('close');
      return;
    }
    this.emit('close', classifySshError({ stderr: this.#stderr, exitCode, target: this.#target }));
  }
}

/**
 * Spawn one SSH child and wrap it. A spawn failure (for example `ssh` not on
 * PATH) becomes an asynchronous `error`/`close` pair so callers can treat all
 * failures uniformly.
 *
 * @param {Parameters<typeof buildSshCommand>[0]} options
 * @param {{spawn?: typeof spawnProcess}} [deps]
 * @returns {SshTransport}
 */
export function createSshTransport(options, { spawn = spawnProcess } = {}) {
  const built = buildSshCommand(options);
  let child;
  try {
    child = spawn(built.command, built.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (cause) {
    return failedTransport(built.target, cause);
  }
  return new SshTransport(child, { target: built.target });
}

/** A transport that reports a spawn failure on the next microtask. */
function failedTransport(target, cause) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const transport = new SshTransport(child, { target });
  const error = new AttachError(
    `cannot run ssh${cause?.message === undefined ? '' : `: ${cause.message}`}`,
    'attach/ssh-failed',
  );
  error.retryable = false;
  queueMicrotask(() => {
    transport.emit('error', error);
    transport.emit('close', error);
  });
  return transport;
}
