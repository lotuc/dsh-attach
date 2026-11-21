import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cacheEnvForRoot,
  cacheRootNotApplied,
  normalizeCacheRoot,
  resolveCacheRoot,
  resolveCacheRootOption,
} from '../lib/shared/cache-root.js';

test('validates raw cache roots without throwing', () => {
  assert.equal(normalizeCacheRoot(undefined), null);
  assert.equal(normalizeCacheRoot(null), null);
  assert.equal(normalizeCacheRoot('  '), null);
  assert.equal(normalizeCacheRoot('\u0000'), null);
  assert.equal(normalizeCacheRoot(`/${'x'.repeat(5_000)}`), null);
  assert.equal(normalizeCacheRoot('  /tmp/cache  '), '/tmp/cache');
  assert.equal(normalizeCacheRoot('@session'), '@session');
});

test('resolves cache-root shortcuts from the context they need', () => {
  assert.equal(resolveCacheRoot('@session', { sessionCwd: '/work/project' }), '/work/project/.cache');
  assert.equal(resolveCacheRoot('@cwd', { launchCwd: '/work' }), '/work/.cache');
  assert.equal(resolveCacheRoot('.cache', { launchCwd: '/work' }), '/work/.cache');
  assert.equal(resolveCacheRoot('@session'), null);
  assert.equal(resolveCacheRoot('@cwd'), null);
  assert.equal(resolveCacheRoot('@cwd', { launchCwd: 'relative/work' }), null);
  assert.equal(resolveCacheRoot('.cache'), null);
  assert.equal(resolveCacheRoot('   '), null);
});

test('explicit cache roots do not depend on either cwd', () => {
  assert.equal(resolveCacheRoot('/tmp/cache'), '/tmp/cache');
  assert.equal(
    resolveCacheRoot('/tmp/cache', { launchCwd: '/work', sessionCwd: '/work/project' }),
    '/tmp/cache',
  );
  assert.equal(
    // A token cannot resolve without its own context even when the other exists.
    resolveCacheRoot('@session', { launchCwd: '/work' }),
    null,
  );
});

test('keeps the client entry point and turns invalid values into errors', () => {
  assert.equal(resolveCacheRootOption('', '/work'), null);
  assert.equal(resolveCacheRootOption('@session', '/work'), '@session');
  assert.equal(resolveCacheRootOption('@cwd', '/work'), '/work/.cache');
  assert.equal(resolveCacheRootOption('.cache', '/work'), '/work/.cache');
  assert.equal(resolveCacheRootOption('/tmp/cache', '/work'), '/tmp/cache');
  assert.equal(resolveCacheRootOption('/tmp/cache', '/elsewhere'), '/tmp/cache');
  assert.throws(() => resolveCacheRootOption('\u0000', '/work'), /invalid/u);
  assert.throws(() => resolveCacheRootOption(`/${'x'.repeat(5_000)}`, '/work'), /invalid/u);
});

test('derives cache variables from an explicit root and preserves MAVEN_ARGS', () => {
  const env = cacheEnvForRoot('/cache', { MAVEN_ARGS: '-X' });
  assert.equal(env.CLJ_CACHE, '/cache/clojure/cpcache');
  assert.equal(env.GITLIBS, '/cache/clojure/gitlibs');
  assert.equal(env.GRADLE_USER_HOME, '/cache/gradle');
  assert.equal(env.COURSIER_CACHE, '/cache/coursier');
  assert.equal(env.MAVEN_ARGS, `-X -Dmaven.repo.local=${'/cache/m2/repository'}`);
});

test('derives the same variables for a resolved @session root', () => {
  const root = resolveCacheRoot('@session', { sessionCwd: '/work/project' });
  const env = cacheEnvForRoot(root);
  assert.equal(env.CLJ_CACHE, '/work/project/.cache/clojure/cpcache');
  assert.equal(env.MAVEN_ARGS, '-Dmaven.repo.local=/work/project/.cache/m2/repository');
});

test('rejects unresolved tokens and relative roots in the env derivation', () => {
  assert.deepEqual(cacheEnvForRoot('@session', { MAVEN_ARGS: '-X' }), {});
  assert.deepEqual(cacheEnvForRoot('.cache', { MAVEN_ARGS: '-X' }), {});
  assert.deepEqual(cacheEnvForRoot('relative/cache', { MAVEN_ARGS: '-X' }), {});
  assert.deepEqual(cacheEnvForRoot(''), {});
});

test('reports a disabled explicit root only for an applied open', () => {
  assert.equal(cacheRootNotApplied({ applied: true, cacheRoot: null }, true), true);
  assert.equal(cacheRootNotApplied({ applied: true, cacheRoot: '/cache' }, true), false);
  // A superseded open's null root is not in effect, so it must stay silent.
  assert.equal(cacheRootNotApplied({ applied: false, cacheRoot: null }, true), false);
  // Older Hosts omit `applied`; their response still counts.
  assert.equal(cacheRootNotApplied({ cacheRoot: null }, true), true);
  assert.equal(cacheRootNotApplied({ applied: true, cacheRoot: null }, false), false);
  assert.equal(cacheRootNotApplied(undefined, true), false);
});
