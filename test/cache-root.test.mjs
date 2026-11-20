import assert from 'node:assert/strict';
import test from 'node:test';

import { cacheEnvForRoot, normalizeCacheRoot, resolveCacheRootOption } from '../lib/shared/cache-root.js';

test('resolves cache-root shortcuts relative to the launching client', () => {
  assert.equal(resolveCacheRootOption('', '/work'), null);
  assert.equal(resolveCacheRootOption('@session', '/work'), '@session');
  assert.equal(resolveCacheRootOption('@cwd', '/work'), '/work/.cache');
  assert.equal(resolveCacheRootOption('.cache', '/work'), '/work/.cache');
  assert.equal(resolveCacheRootOption('/tmp/cache', '/work'), '/tmp/cache');
  assert.throws(() => resolveCacheRootOption('\u0000', '/work'), /invalid/u);
  assert.equal(normalizeCacheRoot('  '), null);
  assert.equal(normalizeCacheRoot('/tmp/cache'), '/tmp/cache');
});

test('derives cache variables from an explicit root and preserves MAVEN_ARGS', () => {
  const env = cacheEnvForRoot('/cache', '/work', { MAVEN_ARGS: '-X' });
  assert.equal(env.CLJ_CACHE, '/cache/clojure/cpcache');
  assert.equal(env.GITLIBS, '/cache/clojure/gitlibs');
  assert.equal(env.GRADLE_USER_HOME, '/cache/gradle');
  assert.equal(env.COURSIER_CACHE, '/cache/coursier');
  assert.equal(env.MAVEN_ARGS, `-X -Dmaven.repo.local=${'/cache/m2/repository'}`);
});

test('resolves @session against the session cwd', () => {
  const env = cacheEnvForRoot('@session', '/work/project');
  assert.equal(env.CLJ_CACHE, '/work/project/.cache/clojure/cpcache');
  assert.equal(env.MAVEN_ARGS, '-Dmaven.repo.local=/work/project/.cache/m2/repository');
  assert.deepEqual(cacheEnvForRoot('@session', ''), {});
});
