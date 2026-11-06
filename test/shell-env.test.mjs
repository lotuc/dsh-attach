import assert from 'node:assert/strict';
import test from 'node:test';

import { herdrEnvFromClient, mergeShellEnv } from '../lib/host/shell-env.js';

test('accepts only bounded HERDR_* values from the client', () => {
  assert.deepEqual(herdrEnvFromClient({
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'w1:p1',
    HERDR_SOCKET_PATH: '/tmp/herdr.sock',
    PATH: '/usr/bin',
    herdr_lower: 'no',
    HERDR_EMPTY: '',
    HERDR_NUMBER: 3,
  }), {
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'w1:p1',
    HERDR_SOCKET_PATH: '/tmp/herdr.sock',
  });
  assert.deepEqual(herdrEnvFromClient(null), {});
});

test('merges the client environment after the caller environment', () => {
  const request = { command: 'pwd', env: { BASE: '1', HERDR_PANE_ID: 'old' } };
  assert.deepEqual(mergeShellEnv(request, { HERDR_PANE_ID: 'new' }), {
    command: 'pwd',
    env: { BASE: '1', HERDR_PANE_ID: 'new' },
  });
  assert.equal(mergeShellEnv(request, {}), request);
});
