import assert from 'node:assert/strict';
import { spawn as spawnProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { AttachClient } from '../lib/client/connection.js';
import {
  FATAL_SSH_ERROR_CODES,
  buildRemoteCommand,
  buildSshCommand,
  classifySshError,
  createSshTransport,
  isFatalSshCode,
  isRetryableAttachCode,
  posixQuote,
} from '../lib/client/ssh-transport.js';
import { PROTOCOL_VERSION, encodeLine } from '../lib/shared/protocol.js';
import { startAttachHost } from './helpers/attach-host.mjs';

const CLI_PATH = fileURLToPath(new URL('../bin/dsh-attach.js', import.meta.url));

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = null;
  child.kill = (signal) => {
    child.killed = signal;
    child.emit('close', 0, signal);
  };
  child.stdin.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return child;
}

/**
 * Spawn stub that speaks the attach protocol on the child's stdout.
 * `onHello` receives each parsed client line and a `reply` helper.
 */
function mockSpawn(onHello) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = fakeChild();
    const call = { command, args, options, child };
    calls.push(call);
    let buffer = '';
    child.stdin.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          message = null;
        }
        onHello?.(message, { child, call });
        newline = buffer.indexOf('\n');
      }
    });
    return child;
  };
  return { spawn, calls };
}

function writeFrame(child, message) {
  child.stdout.write(encodeLine(message));
}

test('builds an SSH command with keepalives, batch mode, and quoting', () => {
  const plain = buildSshCommand({ target: 'user@example.com' });
  assert.equal(plain.command, 'ssh');
  assert.equal(plain.args[0], '-T');
  assert.ok(plain.args.includes('ServerAliveInterval=10'));
  assert.ok(plain.args.includes('ServerAliveCountMax=3'));
  assert.ok(plain.args.includes('ConnectTimeout=10'));
  assert.equal(plain.args.includes('BatchMode=yes'), false);
  assert.equal(plain.args.at(-2), 'user@example.com');
  assert.match(plain.args.at(-1), /--stdio-proxy/u);

  const scripted = buildSshCommand({
    target: 'build-box',
    profile: 'desk top',
    endpoint: '/tmp/a b/endpoint.json',
    batchMode: true,
    sshOpts: ['-o', 'StrictHostKeyChecking=accept-new'],
  });
  assert.ok(scripted.args.includes('BatchMode=yes'));
  assert.deepEqual(scripted.args.slice(-2), ['build-box', scripted.remoteCommand]);
  assert.match(scripted.remoteCommand, /'--profile' 'desk top'/u);
  assert.match(scripted.remoteCommand, /'--endpoint' '\/tmp\/a b\/endpoint\.json'/u);
  assert.ok(scripted.args.includes('StrictHostKeyChecking=accept-new'));

  assert.throws(() => buildSshCommand({ target: '  ' }), /--ssh needs a target/u);
  assert.equal(posixQuote(''), "''");
  assert.equal(posixQuote("it's"), `'it'\\''s'`);
  assert.equal(
    buildRemoteCommand({ remoteBin: '~/bin/dsh-attach' }),
    `exec "$HOME"/'bin/dsh-attach' '--stdio-proxy'`,
  );
  assert.equal(
    buildRemoteCommand({ remoteBin: '/opt/dsh attach' }),
    `exec '/opt/dsh attach' '--stdio-proxy'`,
  );
  assert.equal(
    buildRemoteCommand({ remoteBin: 'C:\\Tools\\dsh-attach.cmd', profile: 'desk' }),
    `"C:\\Tools\\dsh-attach.cmd" "--stdio-proxy" "--profile" "desk"`,
  );
  const probe = buildRemoteCommand({});
  assert.match(probe, /command -v "\$candidate"/u);
  assert.match(probe, /exit 127/u);
  assert.match(probe, /\/\.dsh\/profiles\/\*\/node_modules\/\.bin\/dsh-attach/u);
});

test('classifies fatal SSH errors with stable codes', () => {
  const auth = classifySshError({ stderr: 'Permission denied (publickey).', exitCode: 255, target: 'h' });
  assert.equal(auth.code, 'attach/ssh-auth');
  assert.equal(auth.retryable, false);
  assert.match(auth.message, /authentication failed/u);
  assert.equal(isFatalSshCode(auth.code), true);
  assert.equal(FATAL_SSH_ERROR_CODES.has(auth.code), true);

  const bin = classifySshError({
    stderr: 'dsh-attach: remote dsh-attach not found; install it in that profile or pass --remote-bin',
    exitCode: 127,
    target: 'h',
  });
  assert.equal(bin.code, 'attach/ssh-remote-bin');
  assert.equal(bin.retryable, false);

  const protocol = classifySshError({
    stderr: 'endpoint /x speaks protocol 2, expected 1',
    exitCode: 1,
  });
  assert.equal(protocol.code, 'attach/ssh-failed');
  assert.equal(protocol.retryable, false);

  const unknown = classifySshError({ stderr: 'something odd', exitCode: 255 });
  assert.equal(unknown.code, 'attach/ssh-failed');
  assert.equal(unknown.retryable, false);
});

test('classifies transient SSH errors as retryable', () => {
  const timeout = classifySshError({
    stderr: 'ssh: connect to host h port 22: Connection timed out',
    exitCode: 255,
  });
  assert.equal(timeout.code, 'attach/timeout');
  assert.equal(timeout.retryable, true);
  assert.equal(isRetryableAttachCode(timeout.code), true);

  const unreachable = classifySshError({
    stderr: 'Connection reset by peer',
    exitCode: 255,
  });
  assert.equal(unreachable.code, 'attach/unreachable');
  assert.equal(unreachable.retryable, true);

  const closed = classifySshError({ stderr: '', exitCode: 0 });
  assert.equal(closed.code, 'attach/closed');
  assert.equal(closed.retryable, true);
});

test('AttachClient connects over a mock SSH transport and sends an empty token', async () => {
  let hello = null;
  const { spawn, calls } = mockSpawn((message, { child }) => {
    if (message?.type === 'hello') {
      hello = message;
      writeFrame(child, {
        type: 'welcome',
        protocol: PROTOCOL_VERSION,
        host: { capabilities: ['sandbox.roots'] },
        config: {},
      });
      return;
    }
    if (message?.type === 'request' && message.method === 'session.list') {
      writeFrame(child, { type: 'response', id: message.id, ok: true, result: { items: [] } });
    }
  });
  const client = new AttachClient();
  try {
    await client.connect({ ssh: 'user@host', spawn, timeoutMs: 1_000 });
    assert.equal(hello?.token, '');
    assert.equal(client.descriptor, null);
    assert.deepEqual(client.host?.capabilities, ['sandbox.roots']);
    assert.deepEqual(await client.request('session.list'), { items: [] });
    const { args } = calls[0];
    assert.equal(args[0], '-T');
    assert.equal(args.at(-2), 'user@host');
  } finally {
    client.close();
  }
});

test('AttachClient reconnects through a fresh SSH transport', async () => {
  let generation = 0;
  const { spawn, calls } = mockSpawn((message, { child }) => {
    if (message?.type === 'hello') {
      generation += 1;
      const current = generation;
      writeFrame(child, {
        type: 'welcome',
        protocol: PROTOCOL_VERSION,
        host: { generation: current },
        config: {},
      });
    }
  });
  const client = new AttachClient();
  try {
    await client.connect({ ssh: 'user@host', spawn, timeoutMs: 1_000 });
    assert.equal(client.host?.generation, 1);
    await client.reconnect({ ssh: 'user@host', spawn, timeoutMs: 1_000 });
    assert.equal(client.host?.generation, 2);
    assert.equal(calls.length, 2);
    // The old child is terminated so an orphan proxy cannot linger.
    assert.equal(calls[0].child.killed, 'SIGTERM');
  } finally {
    client.close();
  }
});

test('AttachClient reports a fatal SSH auth failure with its stable code', async () => {
  const spawn = () => {
    const child = fakeChild();
    setTimeout(() => {
      child.stderr.write('user@host: Permission denied (publickey).\n');
      child.emit('close', 255, null);
    }, 20);
    return child;
  };
  const client = new AttachClient();
  try {
    await assert.rejects(
      client.connect({ ssh: 'user@host', spawn, timeoutMs: 1_000 }),
      (error) => error?.code === 'attach/ssh-auth',
    );
  } finally {
    client.close();
  }
});

test('createSshTransport surfaces a missing ssh executable as ssh-failed', async () => {
  const transport = createSshTransport({ target: 'h' }, { spawn: () => {
    throw new Error('spawn ssh ENOENT');
  } });
  await assert.rejects(
    new Promise((resolve, reject) => {
      transport.once('error', reject);
      transport.once('close', (error) => reject(error ?? new Error('closed')));
      setTimeout(resolve, 200);
    }),
    (error) => error?.code === 'attach/ssh-failed' && /cannot run ssh/u.test(error.message),
  );
});


test('end-to-end: AttachClient over a mock ssh child that runs the real stdio proxy', async () => {
  const host = await startAttachHost();
  const client = new AttachClient();
  try {
    // Replace the `ssh` executable with a local child that runs the remote
    // proxy. DSH_HOME is inherited, so the proxy discovers the fixture
    // descriptor and injects its token just like a real SSH hop.
    const spawn = (_command, _args, options) => spawnProcess(
      process.execPath,
      [CLI_PATH, '--stdio-proxy', '--profile', 'routes'],
      { ...options, env: process.env },
    );
    await client.connect({ ssh: 'mock-host', spawn, timeoutMs: 3_000 });
    const listed = await client.request('session.list');
    assert.equal(listed.items[0].sessionId, 's1');
    assert.equal(client.descriptor, null);
  } finally {
    client.close();
    await host.cleanup();
  }
});


test('end-to-end: reconnect discovers a restarted Host with a rotated token', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-ssh-restart-'));
  let host = await startAttachHost({ home });
  const client = new AttachClient();
  const localSpawn = () => (_command, _args, options) => spawnProcess(
    process.execPath,
    [CLI_PATH, '--stdio-proxy', '--profile', 'routes'],
    { ...options, env: process.env },
  );
  try {
    await client.connect({ ssh: 'mock-host', spawn: localSpawn(), timeoutMs: 3_000 });
    assert.equal((await client.request('session.list')).items[0].sessionId, 's1');
    // Restart the only Host process: new PID, same socket path, new token.
    await host.server.stop();
    host = await startAttachHost({ home });
    await client.reconnect({ ssh: 'mock-host', spawn: localSpawn(), timeoutMs: 3_000 });
    assert.equal((await client.request('session.list')).items[0].sessionId, 's1');
  } finally {
    client.close();
    await host.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});
