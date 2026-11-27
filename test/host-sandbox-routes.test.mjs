import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AttachClient } from '../lib/client/connection.js';
import { createHostFixture, expectRouteError, startAttachHost } from './helpers/attach-host.mjs';

const delay = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-routes-roots-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createPolicy() {
  const registered = [];
  const disposed = [];
  return {
    registered,
    disposed,
    registerWritableRoot(session, directory) {
      registered.push({ session, directory });
      return () => disposed.push(directory);
    },
  };
}

/** Start a real Host, connect a client, and run one section. */
async function withHost({ policy, before } = {}, fn) {
  const fixture = createHostFixture();
  if (policy !== undefined) fixture.services.sandboxPolicy = policy;
  if (before !== undefined) before(fixture);
  const host = await startAttachHost({ fixture });
  const client = new AttachClient();
  try {
    await client.connect({ timeoutMs: 2000 });
    await fn({ ...host, client });
  } finally {
    client.close();
    await host.cleanup();
  }
}

test('advertises sandbox roots only when the Host exposes sandboxPolicy', async () => {
  await withHost({ policy: createPolicy() }, async ({ client }) => {
    assert.equal(client.host.capabilities.includes('sandbox.roots'), true);
    assert.equal(client.host.capabilities.includes('approval.session-allow'), true);
  });
  await withHost({}, async ({ client }) => {
    assert.equal(client.host.capabilities.includes('sandbox.roots'), false);
    assert.equal(client.host.capabilities.includes('approval.session-allow'), true);
  });
});

test('registers the cache root, lists it, and grants or revokes another directory', async () => {
  await withTempDir(async (base) => {
    const cache = join(base, 'cache');
    const extra = join(base, 'extra');
    await mkdir(cache);
    await mkdir(extra);
    const policy = createPolicy();
    await withHost({ policy }, async ({ client, agent, server }) => {
      const opened = await client.request('session.open', { sessionId: 's1', cacheRoot: cache });
      assert.equal(opened.applied, true);
      assert.equal(policy.registered.length, 1);
      assert.equal(policy.registered[0].session, agent.session);
      assert.equal(policy.registered[0].directory, realpathSync(cache));

      assert.deepEqual(await client.request('sandbox.dirs'), {
        supported: true,
        directories: [realpathSync(cache)],
        pending: [],
      });

      const granted = await client.request('sandbox.allowDir', { directory: extra });
      assert.equal(granted.supported, true);
      assert.equal(granted.registered, true);
      assert.equal(granted.directory, realpathSync(extra));
      assert.deepEqual(granted.directories, [realpathSync(cache), realpathSync(extra)].sort());
      assert.deepEqual(granted.pending, []);

      const revoked = await client.request('sandbox.revokeDir', { directory: extra });
      assert.equal(revoked.removed, true);
      assert.deepEqual(revoked.directories, [realpathSync(cache)]);
      assert.deepEqual(policy.disposed, [realpathSync(extra)]);

      const missing = await client.request('sandbox.revokeDir', { directory: extra });
      assert.equal(missing.removed, false);

      await expectRouteError(client.request('sandbox.allowDir', {}), 'attach/bad-request');
      await expectRouteError(
        client.request('sandbox.allowDir', { directory: join(base, 'missing') }),
        'attach/invalid-root',
      );
      await expectRouteError(
        client.request('sandbox.allowDir', { directory: 'relative/path' }),
        'attach/invalid-root',
      );

      // Disconnect releases this connection's remaining grant.
      client.close();
      await delay();
      assert.deepEqual(policy.disposed, [realpathSync(extra), realpathSync(cache)]);
      assert.ok(server.connections.size === 0);
    });
  });
});

test('resolving an idle session registers its pending cache root', async () => {
  await withTempDir(async (base) => {
    const cache = join(base, 'cache');
    await mkdir(cache);
    const policy = createPolicy();
    const session = { id: 's2', header: { cwd: '/work' } };
    await withHost({
      policy,
      before: (fixture) => {
        fixture.state.resolveAgentResult = { agent: { id: 's2', session } };
      },
    }, async ({ client }) => {
      const opened = await client.request('session.open', { sessionId: 's2', cacheRoot: cache });
      assert.equal(opened.applied, true);
      const pending = await client.request('sandbox.dirs');
      assert.deepEqual(pending.directories, []);
      assert.deepEqual(pending.pending, [realpathSync(cache)]);

      // Resolving the agent for an explicit command is the first moment the
      // live Session exists; the pending root must register before a tool runs.
      await client.request('commands.execute', { line: '/compact' });
      assert.equal(policy.registered.length, 1);
      assert.equal(policy.registered[0].session, session);
      const active = await client.request('sandbox.dirs');
      assert.deepEqual(active.directories, [realpathSync(cache)]);
      assert.deepEqual(active.pending, []);
    });
  });
});

test('a bad cache root never breaks session.open', async () => {
  await withTempDir(async (base) => {
    const policy = createPolicy();
    await withHost({ policy }, async ({ client }) => {
      const missing = join(base, 'does-not-exist');
      const opened = await client.request('session.open', { sessionId: 's1', cacheRoot: missing });
      assert.equal(opened.applied, true);
      assert.equal(policy.registered.length, 0);
      assert.deepEqual(await client.request('sandbox.dirs'), { supported: true, directories: [], pending: [] });
    });
  });
});

test('a service-level registration failure is reported without breaking the session', async () => {
  await withTempDir(async (base) => {
    const cache = join(base, 'cache');
    await mkdir(cache);
    const policy = {
      registerWritableRoot() {
        throw Object.assign(new Error('invalid root'), { code: 'SANDBOX_INVALID_ROOT' });
      },
    };
    await withHost({ policy }, async ({ client }) => {
      const opened = await client.request('session.open', { sessionId: 's1', cacheRoot: cache });
      assert.equal(opened.applied, true);
      const granted = await client.request('sandbox.allowDir', { directory: cache });
      assert.equal(granted.supported, true);
      assert.equal(granted.registered, false);
      assert.equal(granted.error, 'SANDBOX_INVALID_ROOT');
      assert.deepEqual(granted.directories, []);
      assert.deepEqual(granted.pending, [realpathSync(cache)]);
    });
  });
});

test('sandbox routes degrade when sandboxPolicy is absent', async () => {
  await withTempDir(async (base) => {
    const cache = join(base, 'cache');
    await mkdir(cache);
    await withHost({}, async ({ client }) => {
      await client.request('session.open', { sessionId: 's1', cacheRoot: cache });
      assert.deepEqual(await client.request('sandbox.dirs'), { supported: false, directories: [] });
      const denied = await client.request('sandbox.allowDir', { directory: cache });
      assert.equal(denied.supported, false);
      assert.equal(denied.registered, false);
      const revoked = await client.request('sandbox.revokeDir', { directory: cache });
      assert.equal(revoked.supported, false);
      assert.equal(revoked.removed, false);
    });
  });
});

test('sandbox routes require an open session', async () => {
  await withTempDir(async (base) => {
    await withHost({ policy: createPolicy() }, async ({ client }) => {
      await expectRouteError(client.request('sandbox.dirs'), 'attach/no-session');
      await expectRouteError(client.request('sandbox.allowDir', { directory: base }), 'attach/no-session');
    });
  });
});

test('session.prompt activates pending writable roots once the session becomes live', async () => {
  await withTempDir(async (base) => {
    const extra = join(base, 'extra');
    await mkdir(extra);
    const policy = createPolicy();
    const liveSession = { id: 's2', header: { cwd: '/work' } };
    let awake = false;
    await withHost({
      policy,
      before: (fixture) => {
        const originalGet = fixture.services.agents.get.bind(fixture.services.agents);
        fixture.services.agents.get = (id) => (
          id === 's2' && awake ? { id: 's2', session: liveSession } : originalGet(id)
        );
        const originalPrompt = fixture.ctx.sessionController.prompt;
        fixture.ctx.sessionController.prompt = async (request, signal) => {
          awake = true;
          return originalPrompt(request, signal);
        };
      },
    }, async ({ client }) => {
      await client.request('session.open', { sessionId: 's2' });
      const granted = await client.request('sandbox.allowDir', { directory: extra });
      assert.equal(granted.registered, false);
      assert.deepEqual(granted.pending, [realpathSync(extra)]);
      assert.equal(policy.registered.length, 0);

      await client.request('session.prompt', { text: 'hello' });
      assert.equal(policy.registered.length, 1);
      assert.equal(policy.registered[0].session, liveSession);
      assert.equal(policy.registered[0].directory, realpathSync(extra));
      assert.deepEqual(await client.request('sandbox.dirs'), {
        supported: true,
        directories: [realpathSync(extra)],
        pending: [],
      });
    });
  });
});
