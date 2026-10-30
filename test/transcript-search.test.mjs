import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTranscriptSearch, firstTranscriptMatch } from '../lib/client/transcript-search.js';

const rows = [
  { render: () => ['hello', 'world'] },
  { render: () => [''] },
  { render: () => ['second', 'block', 'here'] },
  { render: () => ['   '] },
  { render: () => ['tail'] },
];

test('buildTranscriptSearch records row and absolute line offsets', () => {
  const items = buildTranscriptSearch(rows, 80);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.offset), [0, 3, 7]);
  assert.deepEqual(items.map((item) => item.rowIndex), [0, 2, 4]);
  assert.match(items[0].meta, /hello\nworld/);
});

test('buildTranscriptSearch skips blank rows but keeps their height', () => {
  const items = buildTranscriptSearch(rows, 80);
  assert.equal(items[1].offset, 3);
  assert.equal(items[1].description, 'row 3 · line 4');
});

test('firstTranscriptMatch is case-insensitive and returns null for no match', () => {
  const items = buildTranscriptSearch(rows, 80);
  assert.equal(firstTranscriptMatch(items, 'SECOND').offset, 3);
  assert.equal(firstTranscriptMatch(items, 'tail').offset, 7);
  assert.equal(firstTranscriptMatch(items, 'missing'), null);
  assert.equal(firstTranscriptMatch(items, '   '), null);
});
