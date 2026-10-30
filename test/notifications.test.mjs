import assert from 'node:assert/strict';
import test from 'node:test';

import { BELL, bellEnabled, shouldRingBell } from '../lib/client/notifications.js';

test('bell is enabled by default and can be disabled explicitly', () => {
  assert.equal(bellEnabled({}), true);
  assert.equal(bellEnabled({ DSH_ATTACH_BELL: '1' }), true);
  assert.equal(bellEnabled({ DSH_ATTACH_BELL: '0' }), false);
});

test('bell rings only for an unfocused terminal', () => {
  assert.equal(shouldRingBell({ enabled: true, focused: false }), true);
  assert.equal(shouldRingBell({ enabled: true, focused: true }), false);
  assert.equal(shouldRingBell({ enabled: false, focused: false }), false);
  assert.equal(BELL, '\x07');
});
