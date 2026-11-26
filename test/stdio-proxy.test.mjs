import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runStdioProxy } from '../lib/client/stdio-proxy.js';
import { ENDPOINT_DIR, ENDPOINT_FILE, PROTOCOL_VERSION, encodeLine } from '../lib/shared/protocol.js';

async function waitFor(predicate, { timeoutMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

async function startBridge(onLine) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-stdio-proxy-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-attach-stdio-${process.pid}-${Date.now()}`
    : join(dir, 'attach.sock');
  const sockets = new Set();
  const lines = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          message = { malformed: line };
        }
        lines.push(message);
        onLine?.(message, socket);
        newline = buffer.indexOf('\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    dir,
    socketPath,
    lines,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function streams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = [];
  const err = [];
  stdout.on('data', (chunk) => out.push(String(chunk)));
  stderr.on('data', (chunk) => err.push(String(chunk)));
  return {
    stdin,
    stdout,
    stderr,
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

test('injects the descriptor token into the opening hello and pipes frames raw', async () => {
  const bridge = await startBridge();
  const io = streams();
  const signalSource = new EventEmitter();
  const running = runStdioProxy({
    socketPath: bridge.socketPath,
    token: 'secret-token',
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    signalSource,
  });
  try {
    io.stdin.write(encodeLine({
      type: 'hello',
      token: '',
      client: { name: 'dsh-attach', protocol: PROTOCOL_VERSION },
    }));
    const requestLine = '{"type":"request","id":1,"method":"session.list","params":{}}\n';
    io.stdin.write(requestLine);
    await waitFor(() => bridge.lines.length === 2);
    assert.equal(bridge.lines[0].type, 'hello');
    assert.equal(bridge.lines[0].token, 'secret-token');
    assert.equal(bridge.lines[0].client.name, 'dsh-attach');
    assert.deepEqual(bridge.lines[1], { type: 'request', id: 1, method: 'session.list', params: {} });

    const socket = [...bridge.sockets][0];
    const welcome = encodeLine({
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      host: { capabilities: ['sandbox.roots'] },
      config: {},
    });
    const frame = '{"type":"frame","sessionId":"s1","frame":{"type":"snapshot"}}\n';
    socket.write(welcome + frame);
    await waitFor(() => io.out().includes('"welcome"') && io.out().includes('"snapshot"'));
    assert.equal(io.out(), welcome + frame, 'stdout carries only protocol bytes');
    assert.equal(io.err(), '', 'success is silent on stderr');
  } finally {
    io.stdin.end();
    assert.equal(await running, 0);
    await bridge.close();
  }
});

test('discovers the descriptor under DSH_HOME and injects its rotated token', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-proxy-home-'));
  const bridge = await startBridge();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const io = streams();
  try {
    await mkdir(join(home, ENDPOINT_DIR), { recursive: true, mode: 0o700 });
    await writeFile(join(home, ENDPOINT_DIR, ENDPOINT_FILE), `${JSON.stringify({
      protocol: PROTOCOL_VERSION,
      plugin: 'dsh-attach',
      pid: process.pid,
      socketPath: bridge.socketPath,
      token: 'discovered-token',
      profile: null,
    })}\n`);
    const running = runStdioProxy({
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      signalSource: new EventEmitter(),
    });
    io.stdin.write(encodeLine({ type: 'hello', token: '', client: { name: 'dsh-attach' } }));
    await waitFor(() => bridge.lines.length === 1);
    assert.equal(bridge.lines[0].token, 'discovered-token');
    io.stdin.end();
    assert.equal(await running, 0);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await bridge.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('fails closed on a malformed opening frame without touching the socket', async () => {
  const bridge = await startBridge();
  const io = streams();
  try {
    const running = runStdioProxy({
      socketPath: bridge.socketPath,
      token: 'secret-token',
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      signalSource: new EventEmitter(),
    });
    io.stdin.write('this is not json\n');
    assert.equal(await running, 1);
    const frame = JSON.parse(io.out().trim());
    assert.equal(frame.type, 'error');
    assert.equal(frame.error.code, 'attach/stdio-proxy');
    assert.equal(bridge.lines.length, 0);
    assert.match(io.err(), /dsh-attach:/u);
  } finally {
    await bridge.close();
  }
});

test('fails closed when the first frame is not hello', async () => {
  const bridge = await startBridge();
  const io = streams();
  try {
    const running = runStdioProxy({
      socketPath: bridge.socketPath,
      token: 'secret-token',
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      signalSource: new EventEmitter(),
    });
    io.stdin.write(encodeLine({ type: 'request', id: 1, method: 'session.list' }));
    assert.equal(await running, 1);
    const frame = JSON.parse(io.out().trim());
    assert.equal(frame.type, 'error');
    assert.equal(frame.error.code, 'attach/stdio-proxy');
    assert.equal(bridge.lines.length, 0);
  } finally {
    await bridge.close();
  }
});

test('exits cleanly and destroys the local socket when stdin ends', async () => {
  const bridge = await startBridge();
  const io = streams();
  try {
    const running = runStdioProxy({
      socketPath: bridge.socketPath,
      token: 'secret-token',
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      signalSource: new EventEmitter(),
    });
    io.stdin.write(encodeLine({ type: 'hello', token: '', client: { name: 'dsh-attach' } }));
    await waitFor(() => bridge.lines.length === 1);
    const socket = [...bridge.sockets][0];
    assert.equal(socket.destroyed, false);
    io.stdin.end();
    assert.equal(await running, 0);
    await waitFor(() => bridge.sockets.size === 0);
  } finally {
    await bridge.close();
  }
});

test('reports a missing descriptor as an attach error frame', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-proxy-empty-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const io = streams();
  try {
    const running = runStdioProxy({
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      signalSource: new EventEmitter(),
    });
    assert.equal(await running, 1);
    const frame = JSON.parse(io.out().trim());
    assert.equal(frame.type, 'error');
    assert.equal(frame.error.code, 'attach/no-endpoint');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('stops on SIGTERM and cleans up the socket', async () => {
  const bridge = await startBridge();
  const io = streams();
  const signalSource = new EventEmitter();
  try {
    const running = runStdioProxy({
      socketPath: bridge.socketPath,
      token: 'secret-token',
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      signalSource,
    });
    io.stdin.write(encodeLine({ type: 'hello', token: '', client: { name: 'dsh-attach' } }));
    await waitFor(() => bridge.lines.length === 1);
    signalSource.emit('SIGTERM');
    assert.equal(await running, 0);
    await waitFor(() => bridge.sockets.size === 0);
    assert.equal(signalSource.listenerCount('SIGTERM'), 0);
  } finally {
    await bridge.close();
  }
});
