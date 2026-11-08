import assert from 'node:assert/strict';
import test from 'node:test';

import { formatAge, formatClock, formatDuration, shortCwd } from '../lib/client/format.js';

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

test('formats elapsed durations and wall-clock timestamps', () => {
  assert.equal(formatDuration(500), '<1s');
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(125_000), '2m 5s');
  assert.equal(formatDuration(3_600_000), '1h');
  assert.equal(formatDuration(3_900_000), '1h 5m');
  const timestamp = new Date(2026, 10, 8, 23, 44, 23).getTime();
  const sameDay = new Date(2026, 10, 8, 12, 0, 0).getTime();
  assert.equal(formatClock(timestamp, sameDay), '23:44:23');
  const previousDay = new Date(2026, 10, 7, 12, 0, 0).getTime();
  assert.equal(formatClock(timestamp, previousDay), '11-08 23:44:23');
  assert.equal(formatClock(0, sameDay), '');
});
