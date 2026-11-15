import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { focusDesktopSession } from '../lib/client/desktop-focus.js';

test('requests the exact session, then raises DSH with the protocol', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-focus-'));
  const calls = [];
  try {
    const result = focusDesktopSession({
      sessionId: 'session-123',
      home,
      spawnSync: (command, args) => {
        calls.push([command, args]);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(result, { ok: true, requested: true });
    assert.deepEqual(calls, [['open', ['dsh://open']]]);
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'dsh-attach', 'focus-request.json'), 'utf8')), {
      sessionId: 'session-123',
      at: JSON.parse(readFileSync(join(home, 'dsh-attach', 'focus-request.json'), 'utf8')).at,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('rejects an empty session without opening anything', () => {
  const result = focusDesktopSession({ sessionId: '', spawnSync: () => ({ status: 0 }) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no session/u);
});

test('reports a failed protocol open', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-focus-'));
  try {
    const result = focusDesktopSession({
      sessionId: 's1',
      home,
      spawnSync: () => ({ status: 1, stdout: '', stderr: 'no handler' }),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no handler/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
