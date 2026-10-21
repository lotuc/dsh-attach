import assert from 'node:assert/strict';
import test from 'node:test';

import { autocompleteRow } from '../lib/client/autocomplete-layout.js';

const base = {
  rows: 24,
  editorHeight: 3,
  footerHeight: 2,
  activityHeight: 1,
  queueHeight: 2,
  peekHeight: 1,
  lineCount: 5,
};

test('places completions above the editor and all status panels', () => {
  assert.equal(autocompleteRow(base), 10);
  assert.equal(autocompleteRow({ ...base, queueHeight: 4 }), 8);
});

test('treats a missing panel as zero height and never returns a negative row', () => {
  assert.equal(autocompleteRow({ ...base, queueHeight: undefined }), 12);
  assert.equal(autocompleteRow({ ...base, rows: 1, lineCount: 100 }), 1);
});
