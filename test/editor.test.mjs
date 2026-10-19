import assert from 'node:assert/strict';
import test from 'node:test';

import { splitAutocomplete, stripFocusCursor } from '../lib/client/editor.js';

test('splits the rendered completion block off the editor height', () => {
  const lines = ['────', ' hello ', '────', '  → help ', '  sessions '];
  const split = splitAutocomplete(lines, 4);
  assert.deepEqual(split.editor, ['────', ' hello ', '────']);
  assert.deepEqual(split.autocomplete, ['  → help ', '  sessions ']);
});

test('removes the cursor cell while the terminal is unfocused', () => {
  assert.deepEqual(stripFocusCursor(['a\x1b[7m \x1b[0m', '\x1b[7mX\x1b[0mb']), ['a ', 'Xb']);
});

test('keeps plain input when no completion is active', () => {
  const lines = ['────', ' text ', '────'];
  const split = splitAutocomplete(lines, 4);
  assert.deepEqual(split.editor, lines);
  assert.deepEqual(split.autocomplete, []);
});

test('recognizes a scrollable border', () => {
  const border = '─── ↑ 3 more ───';
  const split = splitAutocomplete([border, ' text ', border, '  → help '], 16);
  assert.deepEqual(split.editor, [border, ' text ', border]);
  assert.deepEqual(split.autocomplete, ['  → help ']);
});

test('does not mistake a dashed input line padded with spaces for the border', () => {
  const lines = ['────', ' --  ', '────', '  → help '];
  const split = splitAutocomplete(lines, 4);
  assert.deepEqual(split.editor, ['────', ' --  ', '────']);
  assert.deepEqual(split.autocomplete, ['  → help ']);
});
