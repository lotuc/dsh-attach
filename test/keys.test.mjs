import assert from 'node:assert/strict';
import test from 'node:test';

import { isCtrlKey, isDown, isUp, wheelDirection } from '../lib/client/keys.js';

test('recognizes raw and encoded Ctrl+letter forms', () => {
  assert.equal(isCtrlKey('\x0e', 'n'), true);
  assert.equal(isCtrlKey('\x10', 'p'), true);
  assert.equal(isCtrlKey('\x1b[110;5u', 'n'), true);
  assert.equal(isCtrlKey('\x1b[112;5u', 'p'), true);
  assert.equal(isCtrlKey('\x1b[27;5;110~', 'n'), true);
  assert.equal(isCtrlKey('\x1b[27;5;112~', 'p'), true);
  assert.equal(isCtrlKey('n', 'n'), false);
  assert.equal(isCtrlKey('\x0e', 'p'), false);
});

test('recognizes both arrow encodings', () => {
  assert.equal(isUp('\x1b[A'), true);
  assert.equal(isDown('\x1b[B'), true);
  assert.equal(isUp('\x1bOA'), true);
  assert.equal(isDown('\x1bOB'), true);
  assert.equal(isUp('\x1b[B'), false);
});

test('decodes SGR and legacy mouse wheel events', () => {
  assert.equal(wheelDirection('\x1b[<64;10;5M'), -1);
  assert.equal(wheelDirection('\x1b[<65;10;5M'), 1);
  assert.equal(wheelDirection('\x1b[<0;10;5M'), 0);
  assert.equal(wheelDirection('\x1b[M`!!'), -1);
  assert.equal(wheelDirection('\x1b[Ma!!'), 1);
});
