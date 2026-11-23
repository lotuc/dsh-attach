import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import test from 'node:test';

import { AttachError } from '../lib/client/connection.js';
import { connectWithAutostart, launchHost, resolveHostLaunch } from '../lib/client/autostart.js';

const desktop = { command: 'open', args: ['/Applications/DeepSeek Harness.app'], label: 'DeepSeek Harness' };

test('starts the macOS desktop app for the default profile', () => {
  const launch = resolveHostLaunch({
    platform: 'darwin',
    env: {},
    exists: (path) => path === '/Applications/DeepSeek Harness.app',
    findExecutable: () => {
      throw new Error('should not search PATH');
    },
  });
  assert.deepEqual(launch, desktop);
});

test('uses dsh for an explicit web profile', () => {
  const launch = resolveHostLaunch({
    profile: 'web',
    platform: 'darwin',
    env: { PATH: '/bin' },
    exists: () => true,
    findExecutable: (name, _env, platform) => {
      assert.equal(name, 'dsh');
      assert.equal(platform, 'darwin');
      return '/bin/dsh';
    },
  });
  assert.deepEqual(launch, {
    command: '/bin/dsh',
    args: ['web'],
    label: 'DeepSeek Harness (web)',
    shell: false,
  });
});

test('uses the known Windows desktop install', () => {
  const launch = resolveHostLaunch({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\me' },
    exists: (path) => path.endsWith(join('DeepSeek Harness', 'DeepSeek Harness.exe')),
    findExecutable: () => {
      throw new Error('should not search PATH');
    },
  });
  assert.equal(launch?.label, 'DeepSeek Harness');
  assert.ok(launch?.command.endsWith('DeepSeek Harness.exe'));
});

test('does not try the CLI for the desktop profile without an app', () => {
  assert.equal(resolveHostLaunch({
    profile: 'desktop',
    platform: 'linux',
    env: { PATH: '/bin' },
    exists: () => false,
    findExecutable: () => '/bin/dsh',
  }), null);
});

test('falls back to dsh web when no desktop app is installed', () => {
  const launch = resolveHostLaunch({
    platform: 'linux',
    env: { PATH: '/bin' },
    exists: () => false,
    findExecutable: () => '/opt/dsh',
  });
  assert.equal(launch?.command, '/opt/dsh');
  assert.deepEqual(launch?.args, ['web']);
});

test('spawns the launcher detached with no stdio', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => calls.push(['unref']);
  await launchHost(desktop, {
    env: { DSH_HOME: '/tmp/dsh' },
    spawn: (command, args, options) => {
      calls.push(['spawn', command, args, options]);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.deepEqual(calls[0], ['spawn', 'open', desktop.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
    env: { DSH_HOME: '/tmp/dsh' },
  }]);
  assert.deepEqual(calls[1], ['unref']);
});

test('starts DSH once and waits for the endpoint', async () => {
  let connects = 0;
  const client = {
    async connect() {
      connects += 1;
      if (connects < 3) throw new AttachError('no endpoint', 'attach/no-endpoint');
    },
  };
  const events = [];
  const result = await connectWithAutostart(client, { profile: 'desktop' }, {
    launch: desktop,
    start: async (value) => events.push(['start', value.label]),
    onLaunch: (value) => events.push(['launch', value.label]),
    onWait: (timeout) => events.push(['wait', timeout]),
    timeoutMs: 50,
    pollMs: 1,
  });
  assert.equal(result, desktop);
  assert.equal(connects, 3);
  assert.deepEqual(events, [
    ['launch', 'DeepSeek Harness'],
    ['start', 'DeepSeek Harness'],
    ['wait', 50],
  ]);
});

test('does not start DSH for an explicit endpoint or socket', async () => {
  const original = new AttachError('no endpoint', 'attach/no-endpoint');
  const client = { async connect() { throw original; } };
  let started = 0;
  for (const options of [{ endpoint: '/tmp/e.json' }, { socketPath: '/tmp/s.sock', token: 't' }]) {
    await assert.rejects(
      connectWithAutostart(client, options, {
        start: async () => { started += 1; },
        timeoutMs: 10,
        pollMs: 1,
      }),
      (error) => error === original,
    );
  }
  assert.equal(started, 0);
});

test('keeps the original error when no launcher is known', async () => {
  const original = new AttachError('no endpoint', 'attach/no-endpoint');
  const client = { async connect() { throw original; } };
  await assert.rejects(
    connectWithAutostart(client, {}, { launch: null }),
    (error) => error === original,
  );
});

test('reports a start timeout', async () => {
  const client = {
    async connect() {
      throw new AttachError('missing endpoint', 'attach/no-endpoint');
    },
  };
  await assert.rejects(
    connectWithAutostart(client, {}, {
      launch: desktop,
      start: async () => {},
      timeoutMs: 12,
      pollMs: 1,
    }),
    (error) => error?.code === 'attach/start-timeout' && /no attach endpoint appeared/.test(error.message),
  );
});

test('stops waiting on a non-transient connect error', async () => {
  let connects = 0;
  const client = {
    async connect() {
      connects += 1;
      if (connects === 1) throw new AttachError('no endpoint', 'attach/no-endpoint');
      throw new AttachError('bad protocol', 'attach/protocol');
    },
  };
  await assert.rejects(
    connectWithAutostart(client, {}, {
      launch: desktop,
      start: async () => {},
      timeoutMs: 50,
      pollMs: 1,
    }),
    (error) => error?.code === 'attach/protocol',
  );
  assert.equal(connects, 2);
});

test('wraps a launcher failure', async () => {
  const client = {
    async connect() {
      throw new AttachError('no endpoint', 'attach/no-endpoint');
    },
  };
  await assert.rejects(
    connectWithAutostart(client, {}, {
      launch: desktop,
      start: async () => { throw new Error('open failed'); },
    }),
    (error) => error?.code === 'attach/start-failed' && /open failed/.test(error.message),
  );
});
