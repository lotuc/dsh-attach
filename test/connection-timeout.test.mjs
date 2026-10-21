import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AttachClient } from '../lib/client/connection.js';
import { encodeLine } from '../lib/shared/protocol.js';

async function silentBridge() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-timeout-'));
  const socketPath = join(dir, 'attach.sock');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    socket.once('data', () => {
      socket.write(encodeLine({ type: 'welcome', protocol: 1, host: {}, config: {} }));
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
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('a request is rejected when the Host never replies', async () => {
  const bridge = await silentBridge();
  const client = new AttachClient();
  try {
    await client.connect({ socketPath: bridge.socketPath, token: 'test-token', timeoutMs: 500 });
    await assert.rejects(
      client.request('session.list', {}, { timeoutMs: 30 }),
      (error) => error?.code === 'attach/timeout' && /session\.list/.test(error.message),
    );
  } finally {
    client.close();
    await bridge.close();
  }
});

test('closing the client rejects pending requests immediately', async () => {
  const bridge = await silentBridge();
  const client = new AttachClient();
  try {
    await client.connect({ socketPath: bridge.socketPath, token: 'test-token', timeoutMs: 500 });
    const pending = client.request('session.list', {}, { timeoutMs: 10_000 });
    client.close();
    await assert.rejects(pending, (error) => error?.code === 'attach/closed');
  } finally {
    client.close();
    await bridge.close();
  }
});
