import assert from 'node:assert/strict';
import test from 'node:test';

import { AttachEditor, splitAutocomplete, stripFocusCursor } from '../lib/client/editor.js';
import { editorTheme } from '../lib/client/theme.js';

function makeEditor() {
  return new AttachEditor(
    { requestRender() {} },
    { borderColor: (text) => text, selectList: {} },
  );
}

test('cancels the provider list when backspace removes the slash prefix', async () => {
  const editor = new AttachEditor({ requestRender() {} }, editorTheme);
  let changes = 0;
  editor.onAutocompleteChange = () => {
    changes += 1;
  };
  editor.setAutocompleteProvider({
    async getSuggestions(lines, line, col) {
      const text = (lines[line] ?? '').slice(0, col);
      return text.startsWith('/') ? { items: [{ value: 'help', label: 'help' }], prefix: text } : null;
    },
    applyCompletion(lines, line, col) {
      return { lines, cursorLine: line, cursorCol: col };
    },
  });

  editor.handleInput('/');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(editor.isShowingAutocomplete(), true);

  editor.handleInput('\x7f');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(editor.isShowingAutocomplete(), false);
  assert.ok(changes >= 1);
});

test('notifies when the autocomplete list is cancelled', () => {
  const editor = makeEditor();
  let changes = 0;
  editor.onAutocompleteChange = () => {
    changes += 1;
  };

  editor.autocompleteState = 'regular';
  editor.cancelAutocomplete();
  assert.equal(changes, 1);

  editor.cancelAutocomplete();
  assert.equal(changes, 1);
});

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
