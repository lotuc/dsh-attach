import assert from 'node:assert/strict';
import test from 'node:test';

import { nextScrollOffset, nextSelectionIndex } from '../lib/client/scroll.js';

const state = { scroll: 20, maxScroll: 100, page: 10 };

test('scroll helper decodes wheel, arrows and ctrl navigation', () => {
  assert.equal(nextScrollOffset('\x1b[<64;10;5M', state), 17);
  assert.equal(nextScrollOffset('\x1b[<65;10;5M', state), 23);
  assert.equal(nextScrollOffset('\x1b[A', state), 19);
  assert.equal(nextScrollOffset('\x1b[B', state), 21);
  assert.equal(nextScrollOffset('\x10', state), 19);
  assert.equal(nextScrollOffset('\x0e', state), 21);
});

test('scroll helper pages by the visible body size', () => {
  assert.equal(nextScrollOffset('\x1b[5~', state), 12);
  assert.equal(nextScrollOffset('\x1b[6~', state), 28);
  assert.equal(nextScrollOffset('\x15', state), 12);
  assert.equal(nextScrollOffset('\x04', state), 28);
  assert.equal(nextScrollOffset('\x1b[5~', { scroll: 0, maxScroll: 100, page: 1 }), 0);
});

test('scroll helper handles home and end and clamps the range', () => {
  assert.equal(nextScrollOffset('\x1b[H', state), 0);
  assert.equal(nextScrollOffset('g', state), 0);
  assert.equal(nextScrollOffset('\x1b[F', state), 100);
  assert.equal(nextScrollOffset('G', state), 100);
  assert.equal(nextScrollOffset('\x1b[A', { scroll: 0, maxScroll: 10, page: 4 }), 0);
  assert.equal(nextScrollOffset('\x1b[B', { scroll: 10, maxScroll: 10, page: 4 }), 10);
});

test('scroll helper leaves close and non-scroll keys to the panel', () => {
  assert.equal(nextScrollOffset('\x1b', state), null);
  assert.equal(nextScrollOffset('q', state), null);
  assert.equal(nextScrollOffset('k', state), null);
  assert.equal(nextScrollOffset('', state), null);
});

test('selection helper pages lists with the same overlap as scroll panes', () => {
  const list = { index: 10, length: 30, page: 10 };
  assert.equal(nextSelectionIndex('\x1b[5~', list), 2);
  assert.equal(nextSelectionIndex('\x1b[6~', list), 18);
  assert.equal(nextSelectionIndex('\x15', list), 2);
  assert.equal(nextSelectionIndex('\x04', list), 18);
  assert.equal(nextSelectionIndex('\x1b[H', list), 0);
  assert.equal(nextSelectionIndex('\x1b[F', list), 29);
  assert.equal(nextSelectionIndex('\x1b[A', list), null);
  assert.equal(nextSelectionIndex('\x1b[6~', { index: 0, length: 0, page: 10 }), null);
  assert.equal(nextSelectionIndex('\x1b[5~', { index: 0, length: 3, page: 10 }), 0);
  assert.equal(nextSelectionIndex('\x1b[6~', { index: 2, length: 3, page: 10 }), 2);
});
