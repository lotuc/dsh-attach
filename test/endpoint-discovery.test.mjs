import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AttachClient } from '../lib/client/connection.js';
import {
  ENDPOINT_DIR,
  ENDPOINT_FILE,
  LEGACY_ENDPOINT_DIR,
  PROTOCOL_VERSION,
  encodeLine,
} from '../lib/shared/protocol.js';

async function startBridge(dir, name) {
  const socketPath = join(dir, name);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    socket.once('data', () => {
      socket.write(encodeLine({ type: 'welcome', protocol: PROTOCOL_VERSION, host: {}, config: {} }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function writeDescriptor(home, dir, socketPath) {
  const target = join(home, dir);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await writeFile(join(target, ENDPOINT_FILE), `${JSON.stringify({
    protocol: PROTOCOL_VERSION,
    plugin: 'dsh-attach',
    pluginVersion: '0.14.0',
    pid: process.pid,
    socketPath,
    token: 'test-token',
    profile: null,
    home,
    startedAt: Date.now(),
  }, null, 2)}\n`);
}

test('prefers the current endpoint directory and falls back to the legacy one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-discovery-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const current = await startBridge(home, 'current.sock');
  const legacy = await startBridge(home, 'legacy.sock');
  const client = new AttachClient();
  try {
    assert.equal(ENDPOINT_DIR, 'dsh-attach');
    assert.equal(LEGACY_ENDPOINT_DIR, 'tui-attach');
    await writeDescriptor(home, ENDPOINT_DIR, current.socketPath);
    await writeDescriptor(home, LEGACY_ENDPOINT_DIR, legacy.socketPath);

    await client.connect({ timeoutMs: 1_000 });
    assert.equal(client.descriptor?.socketPath, current.socketPath, 'current endpoint wins');

    await rm(join(home, ENDPOINT_DIR), { recursive: true, force: true });
    await client.reconnect({ timeoutMs: 1_000 });
    assert.equal(client.descriptor?.socketPath, legacy.socketPath, 'legacy endpoint remains discoverable');
  } finally {
    client.close();
    await current.close();
    await legacy.close();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('reports both directories when no endpoint exists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-discovery-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const client = new AttachClient();
  try {
    await assert.rejects(
      client.connect({ timeoutMs: 100 }),
      (error) => error?.code === 'attach/no-endpoint'
        && error.message.includes(join(home, ENDPOINT_DIR))
        && error.message.includes(join(home, LEGACY_ENDPOINT_DIR)),
    );
  } finally {
    client.close();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
