import assert from 'node:assert/strict';
import test from 'node:test';

import { ESCAPE_CANCEL_MS, escapeCancelStep } from '../lib/client/escape-cancel.js';

test('arms on the first Escape and cancels on a second press inside the window', () => {
  const first = escapeCancelStep(null, 1_000);
  assert.deepEqual(first, { pendingAt: 1_000, cancel: false });
  const second = escapeCancelStep(first.pendingAt, 1_000 + ESCAPE_CANCEL_MS);
  assert.deepEqual(second, { pendingAt: null, cancel: true });
});

test('re-arms after the window or when no press is pending', () => {
  assert.deepEqual(escapeCancelStep(null, 2_000), { pendingAt: 2_000, cancel: false });
  assert.deepEqual(escapeCancelStep(1_000, 1_000 + ESCAPE_CANCEL_MS + 1), { pendingAt: 1_000 + ESCAPE_CANCEL_MS + 1, cancel: false });
  assert.deepEqual(escapeCancelStep(2_000, 1_999), { pendingAt: 1_999, cancel: false });
});
