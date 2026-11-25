import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import test from 'node:test';

import { SandboxRoots, normalizeWritableRoot } from '../lib/host/sandbox-roots.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-roots-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createContext({ live = true, policy = true, throwCode = null } = {}) {
  const registered = [];
  const disposed = [];
  const agents = new Map();
  const session = { id: 's1', header: { cwd: '/work' } };
  if (live) {
    agents.set('s1', { id: 's1', session });
    agents.set('s2', { id: 's2', session: { id: 's2', header: { cwd: '/work' } } });
  }
  const sandboxPolicy = policy === false ? undefined : {
    registerWritableRoot(target, directory) {
      if (throwCode !== null) throw Object.assign(new Error('invalid root'), { code: throwCode });
      registered.push({ session: target, directory });
      return () => disposed.push(directory);
    },
  };
  const ctx = {
    get(name) {
      if (name === 'sandboxPolicy') return sandboxPolicy;
      if (name === 'agents') return { get: (id) => agents.get(String(id)) };
      return undefined;
    },
  };
  return { ctx, session, agents, registered, disposed };
}

test('grants a physical directory once per owner and revokes its disposer', async () => {
  await withTempDir(async (dir) => {
    const { ctx, session, registered, disposed } = createContext();
    const roots = new SandboxRoots(ctx);
    const owner = {};

    const result = roots.grant(owner, 's1', dir);
    assert.equal(result.ok, true);
    assert.equal(result.directory, realpathSync(dir));
    assert.equal(result.registered, true);
    assert.deepEqual(roots.list('s1'), [realpathSync(dir)]);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].session, session);

    const again = roots.grant(owner, 's1', dir);
    assert.equal(again.registered, true);
    assert.equal(registered.length, 1, 'the same directory is registered once');

    assert.deepEqual(roots.revoke(owner, 's1', dir), { removed: true, directory: realpathSync(dir) });
    assert.deepEqual(disposed, [realpathSync(dir)]);
    assert.deepEqual(roots.list('s1'), []);
  });
});

test('rejects relative, missing, and non-directory roots without calling the service', async () => {
  await withTempDir(async (dir) => {
    const { ctx, registered } = createContext();
    const roots = new SandboxRoots(ctx);
    const owner = {};
    await writeFile(join(dir, 'file.txt'), 'x');
    assert.equal(normalizeWritableRoot('relative/path'), null);
    assert.equal(normalizeWritableRoot(join(dir, 'missing')), null);
    assert.equal(normalizeWritableRoot(join(dir, 'file.txt')), null);
    assert.equal(normalizeWritableRoot(parse(process.cwd()).root), null, 'a filesystem root is never a grant');
    assert.deepEqual(roots.grant(owner, 's1', 'relative/path'), { ok: false, reason: 'invalid-root' });
    assert.deepEqual(roots.grant(owner, 's1', '  '), { ok: false, reason: 'invalid-root' });
    assert.equal(registered.length, 0);
  });
});

test('queues a grant until the Session is live and then refreshes it', async () => {
  await withTempDir(async (dir) => {
    const { ctx, session, registered } = createContext({ live: false });
    const roots = new SandboxRoots(ctx);
    const owner = {};
    const result = roots.grant(owner, 's1', dir);
    assert.equal(result.ok, true);
    assert.equal(result.registered, false);
    assert.equal(result.pending, true);
    assert.equal(registered.length, 0);
    assert.deepEqual(roots.list('s1'), []);
    assert.deepEqual(roots.pending('s1'), [realpathSync(dir)]);

    roots.refresh('s1', session);
    assert.equal(registered.length, 1);
    assert.deepEqual(roots.list('s1'), [realpathSync(dir)]);
    assert.deepEqual(roots.pending('s1'), []);
  });
});

test('keeps another owner grant and disposes only after the last release', async () => {
  await withTempDir(async (dir) => {
    const { ctx, disposed } = createContext();
    const roots = new SandboxRoots(ctx);
    const first = {};
    const second = {};
    roots.grant(first, 's1', dir);
    roots.grant(second, 's1', dir);
    assert.deepEqual(disposed, []);
    roots.release(first, 's1');
    assert.deepEqual(disposed, [], 'the second owner still holds the root');
    roots.release(second, 's1');
    assert.deepEqual(disposed, [realpathSync(dir)]);
    assert.deepEqual(roots.list('s1'), []);
  });
});

test('a refused registration stays local and retries later', async () => {
  await withTempDir(async (dir) => {
    const { ctx } = createContext({ throwCode: 'SANDBOX_INVALID_ROOT' });
    const roots = new SandboxRoots(ctx);
    const result = roots.grant({}, 's1', dir);
    assert.equal(result.ok, true);
    assert.equal(result.registered, false);
    assert.equal(result.error, 'SANDBOX_INVALID_ROOT');
    assert.deepEqual(roots.list('s1'), []);
    assert.deepEqual(roots.pending('s1'), [realpathSync(dir)]);
    assert.doesNotThrow(() => roots.refresh('s1'));
    assert.doesNotThrow(() => roots.release({}, 's1'));
  });
});

test('an older Host without sandboxPolicy degrades to unsupported', async () => {
  await withTempDir(async (dir) => {
    const { ctx } = createContext({ policy: false });
    const roots = new SandboxRoots(ctx);
    assert.equal(roots.available(), false);
    assert.deepEqual(roots.grant({}, 's1', dir), { ok: false, reason: 'unsupported' });
    assert.deepEqual(roots.list('s1'), []);
    assert.doesNotThrow(() => roots.refresh('s1'));
  });
});

test('resolves a symlinked root and still revokes it after deletion', async () => {
  await withTempDir(async (dir) => {
    const real = join(dir, 'real');
    await mkdir(real);
    const linked = join(dir, 'linked');
    await symlink(real, linked, 'dir');
    const { ctx, disposed } = createContext();
    const roots = new SandboxRoots(ctx);
    const owner = {};
    const physical = realpathSync(real);
    roots.grant(owner, 's1', linked);
    assert.deepEqual(roots.list('s1'), [physical]);
    await rm(real, { recursive: true, force: true });
    const removed = roots.revoke(owner, 's1', linked);
    assert.equal(removed.removed, true);
    assert.deepEqual(disposed, [physical]);
  });
});

test('release all and clear dispose every registration', async () => {
  await withTempDir(async (dir) => {
    const other = join(dir, 'other');
    await mkdir(other);
    const { ctx, disposed } = createContext();
    const roots = new SandboxRoots(ctx);
    const owner = {};
    roots.grant(owner, 's1', dir);
    roots.grant(owner, 's2', other);
    roots.release(owner);
    assert.equal(disposed.length, 2);
    assert.deepEqual(roots.list('s1'), []);
    assert.deepEqual(roots.list('s2'), []);

    roots.grant({}, 's1', dir);
    roots.grant({}, 's2', other);
    roots.clear();
    assert.equal(disposed.length, 4);
    assert.deepEqual(roots.list('s1'), []);
    assert.deepEqual(roots.list('s2'), []);
  });
});
