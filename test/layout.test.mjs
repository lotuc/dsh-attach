import assert from 'node:assert/strict';
import test from 'node:test';

import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';

import { fitRight } from '../lib/client/layout.js';

test('fitRight aligns metadata at the right edge', () => {
  assert.equal(fitRight('left', 'right', 20), `left${' '.repeat(11)}right`);
  assert.equal(visibleWidth(fitRight('left', 'right', 20)), 20);
});

test('fitRight keeps the right side when the left label is long', () => {
  const line = fitRight('x'.repeat(80), 'right', 20);
  assert.equal(visibleWidth(line), 20);
  assert.ok(line.endsWith('right'));
});

test('fitRight keeps the right side when it fills the line', () => {
  const line = fitRight('left', 'r'.repeat(19), 20);
  assert.equal(visibleWidth(line), 20);
  assert.ok(line.endsWith('r'.repeat(19)));
});

test('fitRight truncates the right side only when it cannot fit', () => {
  const line = fitRight('left', 'right'.repeat(10), 12);
  assert.equal(visibleWidth(line), 12);
  assert.ok(!line.includes('left'));
});

test('fitRight supports a one-column gap and empty metadata', () => {
  assert.equal(fitRight('left', 'right', 10, { gap: 1 }), `left${' '.repeat(1)}right`);
  assert.equal(fitRight('left', '', 4), 'left');
  assert.equal(stripTerminalSequences(fitRight('left', '', 2)), '..');
});
