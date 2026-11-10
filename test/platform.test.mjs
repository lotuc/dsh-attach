import assert from 'node:assert/strict';
import test from 'node:test';

import { bridgeSocketPath, expandHomePath, isNamedPipePath, signalSpecs } from '../lib/shared/platform.js';

test('uses a named pipe on Windows and a filesystem socket elsewhere', () => {
  const win = bridgeSocketPath({ platform: 'win32', dir: 'C:\\dsh', pid: 42 });
  assert.match(win, /^\\\\\.\\pipe\\dsh-attach-42$/u);
  assert.equal(isNamedPipePath(win), true);
  const unix = bridgeSocketPath({ platform: 'darwin', dir: '/tmp/dsh', pid: 42, tmpDir: '/tmp' });
  assert.match(unix, /attach-42\.sock$/u);
  assert.equal(isNamedPipePath(unix), false);
});

test('keeps an explicit socket/pipe override', () => {
  assert.equal(bridgeSocketPath({ platform: 'win32', configured: '\\\\.\\pipe\\custom' }), '\\\\.\\pipe\\custom');
});

test('only listens to signals supported by the platform', () => {
  assert.deepEqual(signalSpecs('win32').map((entry) => entry.signal), ['SIGTERM', 'SIGINT', 'SIGBREAK']);
  assert.deepEqual(signalSpecs('linux').map((entry) => entry.signal), ['SIGHUP', 'SIGTERM', 'SIGINT', 'SIGQUIT']);
});

test('expands a tilde with both path separators', () => {
  assert.equal(expandHomePath('~/src', '/home/me'), '/home/me/src');
  assert.equal(expandHomePath('~', '/home/me'), '/home/me');
  assert.equal(expandHomePath('src', '/home/me'), 'src');
});
