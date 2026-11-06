import assert from 'node:assert/strict';
import test from 'node:test';

import { hotChildArgs, isHotSource, runHotReload } from '../lib/client/hot-reload.js';

test('hot child args remove only the supervisor flag', () => {
  assert.deepEqual(hotChildArgs(['--hot', '-s', 'session-1', '--theme', 'dark']), [
    '-s',
    'session-1',
    '--theme',
    'dark',
  ]);
});

test('hot reload watches JavaScript sources only', () => {
  assert.equal(isHotSource('app.js'), true);
  assert.equal(isHotSource('nested/module.mjs'), true);
  assert.equal(isHotSource('README.md'), false);
  assert.equal(isHotSource(undefined), false);
});

test('query-string imports create a fresh Host server module', async () => {
  const first = await import('../lib/host/server.js');
  const second = await import('../lib/host/server.js?hot=test');
  assert.notEqual(first.AttachServer, second.AttachServer);
});

test('hot supervisor restarts the child and exits when it quits normally', async () => {
  const { EventEmitter } = await import('node:events');
  const children = [];
  const watchers = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.killed = false;
    child.kill = (signal) => {
      child.killed = true;
      setImmediate(() => child.emit('exit', 0, signal));
    };
    children.push(child);
    return child;
  };
  const watchFn = (_path, callback) => {
    const watcher = { callback, close() {} };
    watchers.push(watcher);
    return watcher;
  };
  const running = runHotReload({
    root: '/tmp/dsh-hot',
    argv: ['--hot', '-s', 'session-1'],
    spawnFn,
    watchFn,
    log: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 1);
  watchers[0].callback('change', 'app.js');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(children.length, 2);
  children[1].emit('exit', 0, null);
  assert.equal(await running, 0);
});
