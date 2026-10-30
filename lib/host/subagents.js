/**
 * Pure helpers for the Host's subagent catalog routes.
 *
 * The routes only differ in how they obtain rows; counting, traversal and the
 * wire shape stay here so the bridge does not duplicate them.
 */

/**
 * Normalize one runtime catalog row for the client.
 * @param {object} row
 * @param {{parentId?: string, depth?: number, activity?: string}} [overrides]
 * @returns {{id: string, parentId: string, depth: number, mode: string, activity: 'running'|'inactive', label: string|null}}
 */
export function mapSubagentRow(row, { parentId, depth, activity } = {}) {
  const resolvedParent = parentId === undefined ? row.parentId : parentId;
  const resolvedDepth = depth === undefined ? row.depth : depth;
  const resolvedActivity = activity === undefined ? row.activity : activity;
  return {
    id: String(row.id),
    parentId: String(resolvedParent),
    depth: Number(resolvedDepth) || 1,
    mode: row.mode ?? 'unknown',
    activity: resolvedActivity === 'running' ? 'running' : 'inactive',
    label: typeof row.label === 'string' ? row.label : null,
  };
}

/**
 * Count subagents below one root and collect the first few active ones.
 * Walks the full descendant tree, including intermediate non-subagent links,
 * but only counts rows whose `origin` is `subagent`.
 *
 * @param {Array<object>} items - `session.list` summaries
 * @param {string} rootId
 * @param {{activeLimit?: number}} [options]
 * @returns {{total: number, running: number, active: Array<{id: string, parentSessionId: string, title: string|null}>}}
 */
export function summarizeSubagents(items, rootId, { activeLimit = 8 } = {}) {
  const children = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const parent = item?.parentSessionId === undefined ? '' : String(item.parentSessionId);
    if (parent === '') continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(item);
  }

  let total = 0;
  let running = 0;
  const active = [];
  const stack = [String(rootId)];
  const seen = new Set(stack);
  while (stack.length > 0) {
    const parent = stack.pop();
    for (const child of children.get(parent) ?? []) {
      const id = String(child.sessionId);
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(id);
      if (child.origin !== 'subagent') continue;
      total += 1;
      if (child.running !== true) continue;
      running += 1;
      if (active.length >= activeLimit) continue;
      const title = child.projections?.values?.title;
      active.push({
        id,
        parentSessionId: String(child.parentSessionId ?? parent),
        title: typeof title === 'string' ? title : null,
      });
    }
  }
  return { total, running, active };
}
