import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeActiveSubagentLabels } from '../lib/client/subagent-labels.js';

test('fills missing labels from the catalog without replacing existing ones', () => {
  const active = [
    { id: 'child-1', title: 'Long task prompt', label: null },
    { id: 'child-2', title: 'Another prompt', label: 'Keep this' },
    { id: 3, title: 'Numeric id' },
    { id: 'child-4', title: 'No catalog row', label: null },
  ];
  const labels = new Map([
    ['child-1', 'Verify worktree cwd'],
    ['child-2', 'Should not replace'],
    ['3', '  '],
  ]);

  assert.deepEqual(mergeActiveSubagentLabels(active, labels), [
    { id: 'child-1', title: 'Long task prompt', label: 'Verify worktree cwd' },
    { id: 'child-2', title: 'Another prompt', label: 'Keep this' },
    { id: 3, title: 'Numeric id' },
    { id: 'child-4', title: 'No catalog row', label: null },
  ]);
});
