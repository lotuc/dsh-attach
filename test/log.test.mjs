import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ClientLog, resolveLogPath } from '../lib/client/log.js';

test('resolves the default and opt-out log paths', () => {
  assert.equal(resolveLogPath({ DSH_ATTACH_LOG: 'off' }), null);
  assert.equal(resolveLogPath({ DSH_ATTACH_LOG: '/tmp/x.log' }), '/tmp/x.log');
  assert.match(resolveLogPath({ DSH_HOME: '/tmp/dsh-home' }), /[\\/]tmp[\\/]dsh-home[\\/]dsh-attach[\\/]client\.log$/u);
});

test('throttles noisy focus events and records the suppressed count', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-log-'));
  const file = join(dir, 'client.log');
  try {
    let now = 1_000;
    const log = new ClientLog(file, { now: () => now });
    log.throttled('focus', 2_000, { state: 'out' });
    log.throttled('focus', 2_000, { state: 'in' });
    now = 3_500;
    log.throttled('focus', 2_000, { state: 'out' });
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /"suppressed":1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writes a 0600 lifecycle log without leaking the token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-log-'));
  const file = join(dir, 'client.log');
  try {
    const log = new ClientLog(file);
    log.start(['--token', 'super-secret-token', '-s', 'session-a']);
    const text = await readFile(file, 'utf8');
    assert.match(text, / start /);
    assert.match(text, /<redacted>/);
    assert.doesNotMatch(text, /super-secret-token/);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
