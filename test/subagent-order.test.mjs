import assert from 'node:assert/strict';
import test from 'node:test';

import { orderSubagentRows } from '../lib/client/subagent-order.js';

test('orders running first then newest while preserving parent-before-child', () => {
  const rows = [
    { id: 'a', parentId: 'root', activity: 'inactive' },
    { id: 'a1', parentId: 'a', activity: 'inactive' },
    { id: 'b', parentId: 'root', activity: 'running' },
    { id: 'c', parentId: 'root', activity: 'inactive' },
  ];
  const times = new Map([
    ['a', 10],
    ['a1', 100],
    ['b', 1],
    ['c', 20],
  ]);
  const ordered = orderSubagentRows(rows, (row) => times.get(row.id) ?? 0, 'root');
  assert.deepEqual(
    ordered.map(({ row, depth }) => `${row.id}:${depth}`),
    ['b:0', 'c:0', 'a:0', 'a1:1'],
  );
});
