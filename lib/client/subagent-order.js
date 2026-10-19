/**
 * Order catalog rows as a stable tree: siblings put running children first,
 * then the most recently updated, while parents always precede their children.
 * @param {Array<object>} rows - catalog rows with `id`, `parentId`, `activity`.
 * @param {(row: object) => number} updatedAt - session update time for tie-breaking.
 * @param {string} rootId - catalog root whose direct children start the walk.
 * @returns {Array<{row: object, depth: number}>}
 */
export function orderSubagentRows(rows, updatedAt, rootId) {
  const childrenByParent = new Map();
  for (const row of rows) {
    const parent = String(row.parentId ?? '');
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(row);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => {
      const leftRunning = left.activity === 'running';
      const rightRunning = right.activity === 'running';
      if (leftRunning !== rightRunning) return leftRunning ? -1 : 1;
      const delta = (updatedAt(right) || 0) - (updatedAt(left) || 0);
      if (delta !== 0) return delta;
      return String(left.id).localeCompare(String(right.id));
    });
  }
  const ordered = [];
  const visited = new Set();
  const emit = (row, depth) => {
    const id = String(row.id);
    if (visited.has(id)) return;
    visited.add(id);
    ordered.push({ row, depth });
    for (const child of childrenByParent.get(id) ?? []) emit(child, depth + 1);
  };
  for (const row of childrenByParent.get(String(rootId)) ?? []) emit(row, 0);
  return ordered;
}
