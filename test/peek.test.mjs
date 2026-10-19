import assert from 'node:assert/strict';
import test from 'node:test';

import { PeekSession } from '../lib/client/peek.js';

test('peek prefers the short catalog label over the session title', () => {
  const peek = new PeekSession({}, {
    id: 'child-1',
    title: '# Worktree worker brief: long task prompt',
    label: '  Verify worktree cwd  ',
  });
  assert.equal(peek.label, 'Verify worktree cwd');
  assert.equal(peek.displayName, 'Verify worktree cwd');

  // A later session title update must not replace the catalog label.
  peek.title = 'A newer session title';
  assert.equal(peek.displayName, 'Verify worktree cwd');
});

test('peek falls back to the session title and then the id', () => {
  const titled = new PeekSession({}, {
    id: 'child-1',
    title: 'Fix dialog stacking',
    label: '   ',
  });
  assert.equal(titled.label, null);
  assert.equal(titled.displayName, 'Fix dialog stacking');

  const untitled = new PeekSession({}, { id: 'abcdef1234567890' });
  assert.equal(untitled.displayName, 'abcdef12');
});
