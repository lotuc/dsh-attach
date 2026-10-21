import assert from 'node:assert/strict';
import test from 'node:test';

import { formatAge, shortCwd } from '../lib/client/format.js';

test('formats ages at stable boundaries', () => {
  const now = 1_000_000_000;
  assert.equal(formatAge(now - 5_000, now), '5s');
  assert.equal(formatAge(now - 90_000, now), '2m');
  assert.equal(formatAge(now - 3_600_000, now), '1h');
  assert.equal(formatAge(now - 2 * 86_400_000, now), '2d');
  assert.equal(formatAge(0, now), '—');
});

test('shortens cwd with home and tail ellipsis', () => {
  assert.equal(shortCwd('/Users/me/work', 80, '/Users/me'), '~/work');
  assert.equal(shortCwd('/Users/me/work', 5, '/Users/me'), '…work');
  assert.equal(shortCwd('', 20, '/Users/me'), '');
});
