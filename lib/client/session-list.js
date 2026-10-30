import { basename } from 'node:path';

import { oneLine, sanitizeText } from './transcript.js';
import { formatAge } from './format.js';

const SESSION_TITLE_WIDTH = 30;
// path (flex), agents, age — keep the age column last so every row ends at
// the same right edge even when a session has no subagents.
const SESSION_COLUMNS = Object.freeze([
  { width: 30, align: 'left', flex: true, ellipsis: 'middle' },
  { width: 10, align: 'right' },
  { width: 8, align: 'right' },
]);

/** Human-facing session label. */
export function sessionLabel(session) {
  const id = typeof session?.sessionId === 'string' ? session.sessionId : '';
  return oneLine(
    sanitizeText(
      typeof session?.title === 'string' && session.title.trim() !== ''
        ? session.title
        : `(untitled) ${id.slice(0, 8)}`,
    ),
  );
}

function workspaceLabel(workspace, cwd) {
  const title = typeof workspace?.title === 'string' ? workspace.title.trim() : '';
  if (title !== '') return sanitizeText(title);
  const path = typeof workspace?.path === 'string' && workspace.path !== '' ? workspace.path : cwd;
  if (path === '') return 'No workspace';
  return sanitizeText(basename(path) || 'Workspace');
}

/**
 * Build one flat session row per visible session. The session title leads;
 * workspace name, workspace path, age, and subagent counts follow it.
 */
export function buildSessionList({
  sessions,
  workspaceView,
  allSessions = sessions,
  currentSessionId = null,
  includeArchived = false,
} = {}) {
  sessions = Array.isArray(sessions) ? sessions : [];
  allSessions = Array.isArray(allSessions) ? allSessions : sessions;
  currentSessionId = currentSessionId === null ? null : String(currentSessionId);
  const archived = new Set((workspaceView?.archivedSessionIds ?? []).map(String));
  const pinned = new Set((workspaceView?.pinnedSessionIds ?? []).map(String));
  const visible = sessions.filter((session) => includeArchived || !archived.has(String(session.sessionId)));

  const workspaceBySession = new Map();
  for (const workspace of Array.isArray(workspaceView?.items) ? workspaceView.items : []) {
    for (const id of workspace.sessionIds ?? []) workspaceBySession.set(String(id), workspace);
  }

  const allById = new Map(allSessions.map((session) => [String(session.sessionId), session]));
  const subagentCounts = new Map();
  const subagentRunning = new Map();
  const rootCache = new Map();
  const rootOf = (id) => {
    if (rootCache.has(id)) return rootCache.get(id);
    let current = id;
    const seen = new Set();
    for (;;) {
      const session = allById.get(current);
      const parent = String(session?.parentSessionId ?? '');
      if (parent === '' || !allById.has(parent) || seen.has(parent)) break;
      seen.add(current);
      current = parent;
    }
    rootCache.set(id, current);
    return current;
  };
  for (const session of allSessions) {
    if (session.origin !== 'subagent') continue;
    const parent = String(session.parentSessionId ?? '');
    if (parent === '') continue;
    const root = rootOf(String(session.sessionId));
    const rootSession = allById.get(root);
    if (rootSession === undefined || rootSession.origin === 'subagent') continue;
    subagentCounts.set(root, (subagentCounts.get(root) ?? 0) + 1);
    if (session.running === true) subagentRunning.set(root, (subagentRunning.get(root) ?? 0) + 1);
  }

  const items = visible.map((session) => {
    const id = String(session.sessionId);
    const workspace = workspaceBySession.get(id);
    const cwd = typeof session.cwd === 'string' && session.cwd !== '' ? session.cwd : workspace?.path ?? '';
    const path = workspace?.path ?? cwd;
    const agents = subagentCounts.get(id) ?? 0;
    const runningAgents = subagentRunning.get(id) ?? 0;
    const age = formatAge(session.updatedAt);
    const title = sessionLabel(session);
    const name = workspaceLabel(workspace, cwd);
    const pathLabel = path === '' ? '' : String(path);
    const isPinned = pinned.has(id);
    const isArchived = archived.has(id);
    const base = name.toLowerCase() === title.toLowerCase() ? title : `${title} · ${name}`;
    const label = `${isPinned ? '◆ ' : ''}${base}${isArchived ? ' · archived' : ''}`;
    return {
      kind: 'session',
      flat: true,
      table: true,
      titleWidth: SESSION_TITLE_WIDTH,
      value: id,
      running: session.running === true,
      current: currentSessionId !== null && id === currentSessionId,
      pinned: isPinned,
      archived: isArchived,
      updatedAt: Number(session.updatedAt) || 0,
      label,
      path: pathLabel,
      columns: [
        { text: pathLabel, ...SESSION_COLUMNS[0] },
        {
          text: agents > 0 ? `${runningAgents > 0 ? `${runningAgents}/${agents}` : agents}` : '',
          ...SESSION_COLUMNS[1],
        },
        { text: age === '—' ? 'unknown' : `${age} ago`, ...SESSION_COLUMNS[2] },
      ],
    };
  });

  items.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    if (left.running !== right.running) return left.running ? -1 : 1;
    return right.updatedAt - left.updatedAt;
  });
  return items;
}
