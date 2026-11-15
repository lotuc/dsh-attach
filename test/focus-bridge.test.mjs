import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FOCUS_TTL_MS,
  startFocusBridge,
  takeFocusRequest,
  writeFocusRequest,
} from '../lib/host/focus-bridge.js';

test('writes and consumes one unexpired focus request', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-focus-'));
  try {
    assert.equal(takeFocusRequest({ home }), null);
    writeFocusRequest('s1', { home, now: 1000 });
    assert.equal(takeFocusRequest({ home, now: 1001 }), 's1');
    assert.equal(takeFocusRequest({ home, now: 1001 }), null);
    writeFocusRequest('s2', { home, now: 1000 });
    assert.equal(takeFocusRequest({ home, now: 1000 + FOCUS_TTL_MS + 1 }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('serves the pending request over loopback HTTP', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-focus-http-'));
  const bridge = startFocusBridge({ home, port: 0 });
  try {
    await new Promise((resolve) => {
      if (bridge.server.listening) resolve();
      else bridge.server.once('listening', resolve);
    });
    writeFocusRequest('s3', { home });
    const port = bridge.server.address().port;
    const first = await fetch(`http://127.0.0.1:${port}/focus`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await first.json(), { sessionId: 's3' });
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/focus`)).json(), {});
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
  } finally {
    await bridge.close();
    rmSync(home, { recursive: true, force: true });
  }
});
