import assert from 'node:assert/strict';
import test from 'node:test';

import { nextScrollOffset } from '../lib/client/scroll.js';

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
