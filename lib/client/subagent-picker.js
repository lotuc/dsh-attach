/** Build the ordered rows for the `/agents` picker from session summaries. */
import { oneLine, sanitizeText } from './transcript.js';
import { sessionLabel } from './session-tree.js';
import { formatAge } from './format.js';

/** Resolve the top-most non-subagent ancestor for the current session. */
function rootOf(byId, sessionId) {
  let rootId = String(sessionId);
  const seen = new Set();
  while (!seen.has(rootId)) {
    seen.add(rootId);
    const parent = byId.get(rootId)?.parentSessionId;
    if (parent === undefined || parent === null || !byId.has(String(parent))) break;
    rootId = String(parent);
  }
  return rootId;
}

export function buildSubagentPicker({ sessions, currentSessionId, rootSessionId }) {
  const list = Array.isArray(sessions) ? sessions : [];
  const byId = new Map(list.map((session) => [String(session.sessionId), session]));
  const rootId = rootOf(byId, rootSessionId);
  const childrenByParent = new Map();
  for (const session of list) {
    if (session.origin !== 'subagent') continue;
    const parent = String(session.parentSessionId ?? '');
    if (parent === '') continue;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(session);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => {
      if ((left.running === true) !== (right.running === true)) return left.running === true ? -1 : 1;
      return (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0);
    });
  }

  const items = [];
  const visited = new Set([rootId]);
  const walk = (parentId, depth) => {
    for (const child of childrenByParent.get(parentId) ?? []) {
      const id = String(child.sessionId);
      if (visited.has(id)) continue;
      visited.add(id);
      const running = child.running === true;
      const current = id === String(currentSessionId);
      items.push({
        value: id,
        parentSessionId: String(child.parentSessionId ?? ''),
        running,
        label: `${'  '.repeat(depth)}${running ? '●' : '○'} ↳ ${sessionLabel(child)}${current ? ' · current' : ''}`,
        description: `${depth === 0 ? 'direct' : 'nested'} · ${running ? 'running' : 'idle'} · ${formatAge(child.updatedAt)} ago`,
      });
      walk(id, depth + 1);
    }
  };
  walk(rootId, 0);
  return {
    items,
    rootId,
    rootLabel: oneLine(sanitizeText(sessionLabel(byId.get(rootId) ?? { sessionId: rootId }))),
    running: items.filter((item) => item.running).length,
  };
}

/** Build picker rows from the lightweight Host `subagent.list` route. */
export function buildSubagentPickerFromRows({ rows, currentSessionId }) {
  const items = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object' || row.id === undefined) continue;
    const id = String(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const depth = Math.max(0, Number(row.depth) || 1);
    const running = row.activity === 'running';
    const label = typeof row.label === 'string' && row.label.trim() !== '' ? row.label.trim() : id.slice(0, 12);
    items.push({
      value: id,
      parentSessionId: row.parentId === undefined ? '' : String(row.parentId),
      running,
      label: `${'  '.repeat(Math.max(0, depth - 1))}${running ? '●' : '○'} ↳ ${oneLine(sanitizeText(label), 80)}${id === String(currentSessionId) ? ' · current' : ''}`,
      description: `${row.mode ?? 'unknown'} · ${running ? 'running' : 'idle'}${depth <= 1 ? ' · direct' : ' · nested'}`,
    });
  }
  return { items, running: items.filter((item) => item.running).length };
}
