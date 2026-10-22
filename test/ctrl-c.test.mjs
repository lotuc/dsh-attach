import assert from 'node:assert/strict';
import test from 'node:test';

import { ctrlCAction } from '../lib/client/ctrl-c.js';

test('exits immediately when idle without an overlay', () => {
  assert.equal(ctrlCAction({ running: false, overlay: false, armedAt: null }), 'quit');
});

test('requires confirmation while running or showing an overlay', () => {
  assert.equal(ctrlCAction({ running: true, overlay: false, armedAt: null }), 'arm');
  assert.equal(ctrlCAction({ running: false, overlay: true, armedAt: null }), 'arm');
  assert.equal(ctrlCAction({ running: true, overlay: false, armedAt: 1_000, now: 1_500 }), 'quit');
  assert.equal(ctrlCAction({ running: true, overlay: false, armedAt: 1_000, now: 3_500 }), 'arm');
});
