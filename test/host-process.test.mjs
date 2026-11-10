import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AttachClient } from '../lib/client/connection.js';
import { AttachServer } from '../lib/host/server.js';
import { ENDPOINT_DIR, ENDPOINT_FILE, encodeLine } from '../lib/shared/protocol.js';
import {
  DEFAULT_CONFIG,
  createHostFixture,
  startAttachHost,
  writeEndpoint,
} from './helpers/attach-host.mjs';

const delay = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test('installs the shell env bridge and restores the original resolver', async () => {
  const fixture = createHostFixture();
  const original = fixture.services.shell.resolve;
  const host = await startAttachHost({ fixture });
  const installed = fixture.services.shell.resolve;
  assert.notEqual(installed, original);
  assert.deepEqual(await installed({ env: { A: '1' } }), { env: { A: '1' } });
  await host.cleanup();
  assert.notEqual(fixture.services.shell.resolve, installed);
  assert.deepEqual(await fixture.services.shell.resolve({ env: { A: '1' } }), { env: { A: '1' } });
});

test('tolerates a frozen shell service during start and stop', async () => {
  const frozen = createHostFixture();
  Object.freeze(frozen.services.shell);
  const frozenHost = await startAttachHost({ fixture: frozen });
  assert.deepEqual(await frozen.services.shell.resolve({ env: { A: '1' } }), { env: { A: '1' } });
  await assert.doesNotReject(frozenHost.cleanup());

  const restore = createHostFixture();
  const restoreHost = await startAttachHost({ fixture: restore });
  Object.freeze(restore.services.shell);
  await assert.doesNotReject(restoreHost.cleanup());
});

test('stop ignores a throwing event disposer', async () => {
  const fixture = createHostFixture();
  fixture.state.disposerThrows = true;
  const host = await startAttachHost({ fixture });
  await assert.doesNotReject(host.cleanup());
});

test('start rejects when the socket path cannot be bound', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-routes-'));
  const notASocket = join(home, 'not-a-socket');
  await mkdir(notASocket, { recursive: true });
  const previous = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE };
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE = 'routes';
  const fixture = createHostFixture();
  const server = new AttachServer(fixture.ctx, { ...DEFAULT_CONFIG, socketPath: notASocket });
  try {
    await assert.rejects(server.start());
  } finally {
    await server.stop().catch(() => {});
    if (previous.home === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous.home;
    if (previous.profile === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = previous.profile;
    await rm(home, { recursive: true, force: true });
  }
});

test('logging failures never break start or the bridge', async () => {
  const fixture = createHostFixture();
  fixture.state.loggerThrows = true;
  const host = await startAttachHost({ fixture });
  if (process.platform === 'win32') assert.match(host.server.socketPath, /^\\\\\.\\pipe\\dsh-attach-/u);
  else assert.match(host.server.socketPath, /\.sock$/u);
  assert.equal(host.descriptor.protocol, 1);
  await host.cleanup();
});

test('start is idempotent and stop tolerates a replaced descriptor', async () => {
  const host = await startAttachHost();
  const socketPath = host.server.socketPath;
  await host.server.start();
  assert.equal(host.server.socketPath, socketPath);
  await writeEndpoint(host.home, 'not json');
  await host.server.stop();
  await host.server.stop();
  await host.cleanup();
});

test('uses a short socket path when the default path is too long', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), `dsh-attach-${'x'.repeat(80)}-`));
  const fixture = createHostFixture();
  let host;
  try {
    host = await startAttachHost({ fixture, home });
    assert.equal(host.descriptor.socketPath, join(tmpdir(), `dsh-attach-${process.pid}.sock`));
    assert.ok(Buffer.byteLength(host.descriptor.socketPath, 'utf8') <= 100);
  } finally {
    await host?.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test('start rejects when the canonical descriptor cannot be replaced', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-routes-'));
  const previous = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE };
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE = 'routes';
  await mkdir(join(home, ENDPOINT_DIR, ENDPOINT_FILE), { recursive: true });
  const fixture = createHostFixture();
  const server = new AttachServer(fixture.ctx, { ...DEFAULT_CONFIG });
  try {
    await assert.rejects(server.start());
  } finally {
    await server.stop().catch(() => {});
    if (previous.home === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous.home;
    if (previous.profile === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = previous.profile;
    await rm(home, { recursive: true, force: true });
  }
});

test('closes a connection that sends malformed JSON after the hello', async () => {
  const host = await startAttachHost();
  const socket = net.createConnection({ path: host.descriptor.socketPath });
  try {
    await once(socket, 'connect');
    socket.setEncoding('utf8');
    const welcome = once(socket, 'data');
    socket.write(encodeLine({
      type: 'hello',
      token: host.descriptor.token,
      client: { name: 'raw-client', features: [] },
    }));
    await welcome;
    const closed = once(socket, 'close');
    socket.write('{not json}\n');
    await closed;
  } finally {
    socket.destroy();
    await host.cleanup();
  }
});

test('a pending request rejects when the Host stops', async () => {
  const host = await startAttachHost();
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    host.ctx.sessionController.list = () => new Promise(() => {});
    const pending = client.request('session.list').then(
      () => null,
      (error) => error,
    );
    await delay(10);
    await host.server.stop();
    const error = await pending;
    assert.equal(error?.code, 'attach/closed');
  } finally {
    client.close();
    await host.cleanup();
  }
});
