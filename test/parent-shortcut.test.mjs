import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldOpenParent } from '../lib/client/parent-shortcut.js';

const base = {
  subagent: true,
  running: false,
  editorText: '',
  overlayOpen: false,
  autocompleteOpen: false,
};

test('opens the parent from an idle subagent with backspace or alt+left', () => {
  assert.equal(shouldOpenParent({ ...base, data: '\x7f' }), true);
  assert.equal(shouldOpenParent({ ...base, data: '\x1b[1;3D' }), true);
  assert.equal(shouldOpenParent({ ...base, data: '\x1b' }), true);
});

test('does not interpret editing or running escape as parent navigation', () => {
  assert.equal(shouldOpenParent({ ...base, data: '\x7f', editorText: 'draft' }), false);
  assert.equal(shouldOpenParent({ ...base, data: '\x1b', running: true }), false);
  assert.equal(shouldOpenParent({ ...base, data: '\x1b', overlayOpen: true }), false);
  assert.equal(shouldOpenParent({ ...base, data: '\x1b', autocompleteOpen: true }), false);
  assert.equal(shouldOpenParent({ ...base, subagent: false, data: '\x7f' }), false);
});
