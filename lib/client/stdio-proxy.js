/**
 * Remote-only byte proxy used by the SSH transport.
 *
 * `dsh-attach --stdio-proxy` runs on the same machine as the Host. It discovers
 * the local endpoint descriptor, dials the Unix socket or Windows named pipe,
 * and forwards the client's NDJSON frames in both directions. The only frame it
 * interprets is the opening `hello`: it injects the descriptor's rotated token
 * so the token never has to leave the remote host.
 *
 * The proxy is deliberately strict about its channels: stdout carries protocol
 * bytes only (no banners), while diagnostics and failure details go to stderr.
 */
import net from 'node:net';

import { MAX_INBOUND_LINE_BYTES, encodeLine } from '../shared/protocol.js';
import { signalSpecs } from '../shared/platform.js';
import {
  AttachError,
  candidateDescriptors,
  readDescriptor,
  resolveEndpointCandidates,
} from './connection.js';
import {
  START_POLL_MS,
  START_TIMEOUT_MS,
  launchHost,
  resolveHostLaunch,
} from './autostart.js';

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function writeTo(stream, text) {
  try {
    stream.write(text);
    return true;
  } catch {
    return false;
  }
}

/** Write one NDJSON error frame to the local client; never throw. */
function writeErrorFrame(stdout, code, message) {
  writeTo(stdout, encodeLine({ type: 'error', error: { code, message } }));
}

/**
 * Wait for a descriptor after optionally starting the Host. `--stdio-proxy`
 * normally expects a running Host, so this path is opt-in via `autoStart`.
 */
async function waitForEndpoint({ profile, diagnostic, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }) }) {
  const launch = resolveHostLaunch({ profile });
  if (launch === null) {
    throw new AttachError(
      'no attach endpoint and no DSH installation to start',
      'attach/no-endpoint',
    );
  }
  diagnostic(`starting ${launch.label}...`);
  try {
    await launchHost(launch);
  } catch (error) {
    throw new AttachError(`could not start ${launch.label}: ${messageOf(error)}`, 'attach/start-failed');
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(Math.min(START_POLL_MS, Math.max(1, deadline - Date.now())));
    const paths = await candidateDescriptors(profile);
    if (paths.length === 0) continue;
    const candidates = [];
    for (const path of paths) {
      try {
        candidates.push(await readDescriptor(path));
      } catch {
        // A descriptor may be mid-write; retry.
      }
    }
    if (candidates.length > 0) return candidates;
  }
  throw new AttachError(
    `started ${launch.label} but no attach endpoint appeared within ${Math.round(START_TIMEOUT_MS / 1000)}s`,
    'attach/start-timeout',
  );
}

/**
 * Resolve candidate descriptors for the proxy.
 * @returns {Promise<Array<{socketPath: string, token: string}>>}
 */
async function discoverCandidates({ endpoint, socketPath, token, profile, autoStart, diagnostic }) {
  if (socketPath !== undefined) {
    if (token === undefined) {
      throw new AttachError(
        '--stdio-proxy with --socket needs --token (or use --endpoint/descriptor discovery)',
        'attach/no-endpoint',
      );
    }
    return [{ socketPath, token, profile: profile ?? null }];
  }
  try {
    return await resolveEndpointCandidates({ endpoint, profile });
  } catch (error) {
    if (autoStart !== true || error?.code !== 'attach/no-endpoint') throw error;
    return await waitForEndpoint({ profile, diagnostic });
  }
}

/** Dial one local socket/named pipe with a bounded timeout. */
function dialLocal(candidate, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection({ path: candidate.socketPath });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new AttachError(`connection timed out after ${timeoutMs}ms`, 'attach/timeout'));
    }, timeoutMs);
    timer.unref?.();
    const onError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('error', onError);
      // Keep one error listener across the handoff to pumpFrames; otherwise an
      // immediate reset between connect and pump would be an unhandled 'error'.
      socket.on('error', () => {});
      resolve(socket);
    });
  });
}

async function connectCandidates(candidates, timeoutMs) {
  const failures = [];
  for (const candidate of candidates) {
    try {
      const socket = await dialLocal(candidate, timeoutMs);
      return { socket, candidate };
    } catch (error) {
      failures.push(`${candidate.socketPath}: ${messageOf(error)}`);
    }
  }
  throw new AttachError(
    `cannot reach the local attach bridge (${failures.join('; ') || 'no usable endpoint'})`,
    'attach/unreachable',
  );
}

/**
 * Serialize the opening `hello`, then forward raw bytes in both directions.
 * Resolves with the process exit code instead of calling `process.exit` so the
 * behavior is testable.
 */
function pumpFrames({ socket, candidate, stdin, stdout, stderr, signalSource }) {
  return new Promise((resolve) => {
    let finished = false;
    let phase = 'hello';
    let hello = Buffer.alloc(0);
    const signalHandlers = [];

    const cleanup = () => {
      stdin.off?.('data', onStdinData);
      stdin.off?.('end', onStdinEnd);
      stdin.off?.('close', onStdinClose);
      stdin.off?.('error', onStdinError);
      socket.off('data', onSocketData);
      socket.off('error', onSocketError);
      socket.off('close', onSocketClose);
      socket.off('drain', onSocketDrain);
      stdout.off?.('error', onStdoutError);
      stdout.off?.('drain', onStdoutDrain);
      for (const [signal, handler] of signalHandlers) signalSource.off?.(signal, handler);
    };

    const finish = (code) => {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        // Stop reading the SSH channel so a still-open stdin pipe cannot keep
        // this orphan-averse process alive after the proxy has finished.
        stdin.pause?.();
      } catch {
        // Best effort.
      }
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
      resolve(code);
    };

    const diagnostic = (message) => writeTo(stderr, `dsh-attach: ${message}\n`);

    const failClosed = (code, message) => {
      writeErrorFrame(stdout, code, message);
      diagnostic(message);
      finish(1);
    };

    const onStdinData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (phase === 'forward') {
        if (socket.write(buffer) === false) stdin.pause?.();
        return;
      }
      hello = hello.length === 0 ? buffer : Buffer.concat([hello, buffer]);
      const newline = hello.indexOf(0x0A);
      if (newline === -1) {
        if (hello.length > MAX_INBOUND_LINE_BYTES) {
          failClosed('attach/stdio-proxy', 'the opening hello frame is too large');
        }
        return;
      }
      const line = hello.subarray(0, newline).toString('utf8');
      const rest = hello.subarray(newline + 1);
      hello = Buffer.alloc(0);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        failClosed('attach/stdio-proxy', 'the SSH proxy received a malformed opening frame');
        return;
      }
      if (message === null || typeof message !== 'object' || Array.isArray(message) || message.type !== 'hello') {
        failClosed('attach/stdio-proxy', 'the SSH proxy expected an opening hello frame');
        return;
      }
      // The real token stays on the remote host: replace whatever the local
      // client sent (normally '') with the current descriptor token.
      message.token = candidate.token;
      phase = 'forward';
      socket.write(encodeLine(message));
      if (rest.length > 0) socket.write(rest);
    };

    const onStdinEnd = () => finish(0);
    const onStdinClose = () => finish(0);
    const onStdinError = () => finish(1);
    const onSocketData = (chunk) => {
      try {
        if (stdout.write(chunk) === false) socket.pause();
      } catch {
        finish(0);
      }
    };
    const onSocketDrain = () => stdin.resume?.();
    const onStdoutDrain = () => socket.resume();
    const onSocketError = (error) => {
      if (phase === 'hello') {
        failClosed('attach/unreachable', `the local attach bridge failed during the handshake: ${messageOf(error)}`);
        return;
      }
      diagnostic(`local attach bridge error: ${messageOf(error)}`);
      finish(0);
    };
    const onSocketClose = () => {
      if (phase === 'hello') {
        failClosed('attach/unreachable', 'the local attach bridge closed during the handshake');
        return;
      }
      finish(0);
    };
    const onStdoutError = () => finish(0);

    stdin.on?.('data', onStdinData);
    stdin.once?.('end', onStdinEnd);
    stdin.once?.('close', onStdinClose);
    stdin.once?.('error', onStdinError);
    socket.on('data', onSocketData);
    socket.on('error', onSocketError);
    socket.on('close', onSocketClose);
    socket.on('drain', onSocketDrain);
    stdout.on?.('error', onStdoutError);
    stdout.on?.('drain', onStdoutDrain);

    const signals = signalSource === process
      ? signalSpecs(process.platform).map((spec) => spec.signal)
      : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const signal of signals) {
      const handler = () => finish(0);
      try {
        signalSource.on(signal, handler);
        signalHandlers.push([signal, handler]);
      } catch {
        // Some hosts do not expose every signal.
      }
    }
    stdin.resume?.();
  });
}

/**
 * Run the remote stdio proxy.
 *
 * @param {{endpoint?: string, socketPath?: string, token?: string, profile?: string,
 *   stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream, autoStart?: boolean,
 *   connectTimeoutMs?: number, signalSource?: NodeJS.EventEmitter}} [options]
 * @returns {Promise<number>} process exit code
 */
export async function runStdioProxy({
  endpoint,
  socketPath,
  token,
  profile,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  autoStart = false,
  connectTimeoutMs = 10_000,
  signalSource = process,
} = {}) {
  const diagnostic = (message) => writeTo(stderr, `dsh-attach: ${message}\n`);
  let candidates;
  try {
    candidates = await discoverCandidates({
      endpoint,
      socketPath,
      token,
      profile,
      autoStart,
      diagnostic,
    });
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'attach/no-endpoint';
    writeErrorFrame(stdout, code, messageOf(error));
    diagnostic(messageOf(error));
    return 1;
  }

  let connected;
  try {
    connected = await connectCandidates(candidates, connectTimeoutMs);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'attach/unreachable';
    writeErrorFrame(stdout, code, messageOf(error));
    diagnostic(messageOf(error));
    return 1;
  }

  return await pumpFrames({
    socket: connected.socket,
    candidate: connected.candidate,
    stdin,
    stdout,
    stderr,
    signalSource,
  });
}
