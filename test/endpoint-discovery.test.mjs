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
    pluginVersion: '2026.1108.2218',
    pid: process.pid,
    socketPath,
    token: 'test-token',
    profile: null,
    home,
    startedAt: Date.now(),
  }, null, 2)}\n`);
}

test('discovers the canonical endpoint directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-discovery-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const current = await startBridge(home, 'current.sock');
  const client = new AttachClient();
  try {
    assert.equal(ENDPOINT_DIR, 'dsh-attach');
    await writeDescriptor(home, ENDPOINT_DIR, current.socketPath);
    await client.connect({ timeoutMs: 1_000 });
    assert.equal(client.descriptor?.socketPath, current.socketPath);
  } finally {
    client.close();
    await current.close();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('reports the canonical directory when no endpoint exists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-discovery-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const client = new AttachClient();
  try {
    await assert.rejects(
      client.connect({ timeoutMs: 100 }),
      (error) => error?.code === 'attach/no-endpoint'
        && error.message.includes(join(home, ENDPOINT_DIR)),
    );
  } finally {
    client.close();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
