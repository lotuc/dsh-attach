import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionEnv } from '../lib/host/session-env.js';

function createContext() {
  const shell = {
    resolve(request) {
      return request;
    },
  };
  return {
    ctx: {
      get(name) {
        return name === 'shell' ? shell : undefined;
      },
    },
    shell,
  };
}

test('replaces the whole connection entry when it opens another session', () => {
  const { ctx } = createContext();
  const env = new SessionEnv(ctx);
  const conn = {};

  env.set(conn, 's1', { HERDR_PANE_ID: 'p1' }, '/cache/a');
  assert.deepEqual(env.envFor('s1'), { env: { HERDR_PANE_ID: 'p1' }, cacheRoot: '/cache/a' });

  env.set(conn, 's2', { HERDR_PANE_ID: 'p2' }, null);
  assert.equal(env.envFor('s1'), undefined);
  assert.deepEqual(env.envFor('s2'), { env: { HERDR_PANE_ID: 'p2' }, cacheRoot: null });

  // A plain open (no Herdr env and no cache root) still drops the old entry.
  env.set(conn, 's3', {}, null);
  assert.equal(env.envFor('s2'), undefined);
  assert.equal(env.envFor('s3'), undefined);
});

test('merges the newest env with the newest non-null cache root', () => {
  const { ctx } = createContext();
  const env = new SessionEnv(ctx);
  const first = {};
  const second = {};

  env.set(first, 's1', { HERDR_PANE_ID: 'p1' }, '/cache/a');
  env.set(second, 's1', { HERDR_PANE_ID: 'p2' }, null);
  assert.deepEqual(env.envFor('s1'), { env: { HERDR_PANE_ID: 'p2' }, cacheRoot: '/cache/a' });

  env.set(second, 's1', { HERDR_PANE_ID: 'p3' }, '/cache/b');
  assert.deepEqual(env.envFor('s1'), { env: { HERDR_PANE_ID: 'p3' }, cacheRoot: '/cache/b' });
});

test('keeps the older Herdr env when a newer entry only carries a cache root', () => {
  const { ctx } = createContext();
  const env = new SessionEnv(ctx);
  const first = {};
  const second = {};

  env.set(first, 's1', { HERDR_ENV: '1', HERDR_PANE_ID: 'p1' }, '/cache/a');
  env.set(second, 's1', null, '/cache/b');
  // Merge directions are independent: the cache-root-only entry wins the root
  // without erasing the older terminal's Herdr facts.
  assert.deepEqual(env.envFor('s1'), { env: { HERDR_ENV: '1', HERDR_PANE_ID: 'p1' }, cacheRoot: '/cache/b' });

  env.remove(second);
  assert.deepEqual(env.envFor('s1'), { env: { HERDR_ENV: '1', HERDR_PANE_ID: 'p1' }, cacheRoot: '/cache/a' });
});

test('removes one session or every entry owned by a connection', () => {
  const { ctx } = createContext();
  const env = new SessionEnv(ctx);
  const first = {};
  const second = {};

  env.set(first, 's1', { HERDR_ENV: '1' }, null);
  env.set(second, 's1', { HERDR_ENV: '1' }, null);
  env.remove(first, 'other');
  assert.notEqual(env.envFor('s1'), undefined);
  env.remove(first, 's1');
  assert.notEqual(env.envFor('s1'), undefined);
  env.remove(second);
  assert.equal(env.envFor('s1'), undefined);
});

test('installs one patched resolver and restores the original', async () => {
  const { ctx, shell } = createContext();
  const env = new SessionEnv(ctx);
  const original = shell.resolve;

  env.install();
  const installed = shell.resolve;
  assert.notEqual(installed, original);
  env.install();
  assert.equal(shell.resolve, installed);

  env.set({}, 's1', { HERDR_PANE_ID: 'p1' }, '/cache');
  const resolved = await shell.resolve({ env: { BASE: '1' }, dshEnv: { DSH_SESSION_ID: 's1' } });
  assert.equal(resolved.env.BASE, '1');
  assert.equal(resolved.env.HERDR_PANE_ID, 'p1');
  assert.equal(resolved.env.CLJ_CACHE, '/cache/clojure/cpcache');

  env.clear();
  const cleared = await shell.resolve({ env: { BASE: '1' }, dshEnv: { DSH_SESSION_ID: 's1' } });
  assert.deepEqual(cleared, { env: { BASE: '1' }, dshEnv: { DSH_SESSION_ID: 's1' } });

  env.restore();
  assert.notEqual(shell.resolve, installed);
  assert.deepEqual(await shell.resolve({ env: { A: '1' } }), { env: { A: '1' } });
});

test('tolerates a missing or frozen shell service', () => {
  const missing = new SessionEnv({ get: () => undefined });
  assert.doesNotThrow(() => missing.install());
  assert.doesNotThrow(() => missing.restore());

  const shell = Object.freeze({ resolve: (request) => request });
  const frozen = new SessionEnv({ get: () => shell });
  assert.doesNotThrow(() => frozen.install());
  assert.doesNotThrow(() => frozen.restore());
  assert.deepEqual(shell.resolve({ env: { A: '1' } }), { env: { A: '1' } });
});
