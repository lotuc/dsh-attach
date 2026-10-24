import { basename } from 'node:path';

import { oneLine, sanitizeText } from './transcript.js';
import { formatAge, shortCwd } from './format.js';

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

/** Human-facing session age and cwd. */
export function sessionDescription(session) {
  const age = formatAge(session?.updatedAt);
  return sanitizeText(`${age === '—' ? 'unknown' : `${age} ago`} · ${shortCwd(session?.cwd ?? '', 48)}`);
}

/**
 * Group visible sessions by durable Workspace, then by cwd for sessions the
 * Workspace registry does not account for. Workspace headers are collapsible;
 * session rows are indented under them.
 */
export function buildSessionTree({
  sessions,
  workspaceView,
  allSessions = sessions,
  currentCwd = process.cwd(),
  currentSessionId = null,
} = {}) {
  sessions = Array.isArray(sessions) ? sessions : [];
  allSessions = Array.isArray(allSessions) ? allSessions : sessions;
  currentCwd = typeof currentCwd === 'string' && currentCwd !== '' ? currentCwd : process.cwd();
  currentSessionId = currentSessionId === null ? null : String(currentSessionId);
  const items = [];
  const archived = new Set((workspaceView?.archivedSessionIds ?? []).map(String));
  const visible = sessions.filter((session) => !archived.has(String(session.sessionId)));
  const byId = new Map(visible.map((session) => [String(session.sessionId), session]));
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

  const normalizePath = (value) => String(value ?? '').replace(/\/+$/u, '') || '/';
  const workspaces = Array.isArray(workspaceView?.items) ? workspaceView.items : [];
  let currentWorkspaceKey = null;
  if (currentSessionId !== null) {
    const containing = workspaces.find((workspace) =>
      (workspace.sessionIds ?? []).some((id) => String(id) === currentSessionId),
    );
    if (containing !== undefined) currentWorkspaceKey = String(containing.workspaceId ?? containing.path ?? '');
  }
  if (currentWorkspaceKey === null) {
    let bestLength = -1;
    for (const workspace of workspaces) {
      const path = normalizePath(workspace.path);
      if (path === '/' || path === '') continue;
      if ((currentCwd === path || currentCwd.startsWith(`${path}/`)) && path.length > bestLength) {
        bestLength = path.length;
        currentWorkspaceKey = String(workspace.workspaceId ?? workspace.path ?? '');
      }
    }
  }

  const used = new Set();
  const groups = [];
  const groupStats = (children) => {
    let agents = 0;
    let agentsRunning = 0;
    let sessionsRunning = 0;
    for (const session of children) {
      const id = String(session.sessionId);
      agents += subagentCounts.get(id) ?? 0;
      agentsRunning += subagentRunning.get(id) ?? 0;
      if (session.running === true) sessionsRunning += 1;
    }
    return { agents, agentsRunning, sessionsRunning };
  };
  const sortChildren = (children) => {
    children.sort((left, right) => {
      const leftCurrent = currentSessionId !== null && String(left.sessionId) === currentSessionId;
      const rightCurrent = currentSessionId !== null && String(right.sessionId) === currentSessionId;
      if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
      if ((left.running === true) !== (right.running === true)) return left.running === true ? -1 : 1;
      return (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0);
    });
  };
  let workspaceOrder = 0;
  for (const workspace of workspaces) {
    const children = (workspace.sessionIds ?? [])
      .map((id) => byId.get(String(id)))
      .filter((session) => session !== undefined && !used.has(String(session.sessionId)));
    if (children.length === 0) continue;
    for (const session of children) used.add(String(session.sessionId));
    const groupKey = `workspace:${String(workspace.workspaceId ?? workspace.path ?? groups.length)}`;
    const title = sanitizeText(
      typeof workspace.title === 'string' && workspace.title.trim() !== ''
        ? workspace.title
        : basename(String(workspace.path ?? '')) || 'Workspace',
    );
    groups.push({
      kind: 'workspace',
      groupKey,
      title,
      path: String(workspace.path ?? ''),
      children,
      stats: groupStats(children),
      current: currentWorkspaceKey !== null && String(workspace.workspaceId ?? workspace.path ?? '') === currentWorkspaceKey,
      order: workspaceOrder++,
    });
  }
  const ungrouped = visible.filter((session) => !used.has(String(session.sessionId)));
  const byCwd = new Map();
  for (const session of ungrouped) {
    const cwd = typeof session.cwd === 'string' && session.cwd !== '' ? session.cwd : '';
    if (!byCwd.has(cwd)) byCwd.set(cwd, []);
    byCwd.get(cwd).push(session);
  }
  const cwdGroups = [...byCwd.entries()].sort((left, right) => {
    const leftAt = Math.max(0, ...left[1].map((session) => Number(session.updatedAt) || 0));
    const rightAt = Math.max(0, ...right[1].map((session) => Number(session.updatedAt) || 0));
    return rightAt - leftAt;
  });
  let cwdOrder = 0;
  for (const [cwd, groupSessions] of cwdGroups) {
    groups.push({
      kind: 'cwd',
      groupKey: `cwd:${cwd || 'none'}`,
      title: cwd === '' ? 'No workspace' : sanitizeText(shortCwd(cwd, 52)),
      path: cwd,
      children: groupSessions,
      stats: groupStats(groupSessions),
      current: currentWorkspaceKey === null && normalizePath(cwd) === normalizePath(currentCwd),
      order: cwdOrder++,
    });
  }

  groups.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    if (left.kind !== right.kind) return left.kind === 'workspace' ? -1 : 1;
    return left.order - right.order;
  });

  const pushSession = (session, group) => {
    const id = String(session.sessionId);
    const count = subagentCounts.get(id) ?? 0;
    const runningAgents = subagentRunning.get(id) ?? 0;
    const suffix = count > 0 ? ` · ${runningAgents > 0 ? `${runningAgents}/${count}` : count} agent${count === 1 ? '' : 's'}` : '';
    const age = formatAge(session.updatedAt);
    const metaParts = [age === '—' ? 'unknown' : `${age} ago`];
    if (count > 0) metaParts.push(`${runningAgents > 0 ? `${runningAgents}/${count}` : count} agent${count === 1 ? '' : 's'}`);
    const current = currentSessionId !== null && id === currentSessionId;
    items.push({
      kind: 'session',
      value: id,
      groupKey: group.groupKey,
      depth: 1,
      running: session.running === true,
      current,
      updatedAt: Number(session.updatedAt) || 0,
      label: sessionLabel(session),
      meta: metaParts.join(' · '),
      description: `${sessionDescription(session)}${suffix}`,
    });
  };

  for (const group of groups) {
    const { agents, agentsRunning, sessionsRunning } = group.stats;
    const metaParts = [`${group.children.length} session${group.children.length === 1 ? '' : 's'}`];
    if (agents > 0) metaParts.push(`${agentsRunning > 0 ? `${agentsRunning}/${agents}` : agents} agent${agents === 1 ? '' : 's'}`);
    if (sessionsRunning > 0) metaParts.push(`${sessionsRunning} running`);
    const path = group.kind === 'workspace' && group.path !== '' ? shortCwd(group.path, 46) : '';
    items.push({
      kind: 'group',
      value: `__group__:${group.groupKey}`,
      groupKey: group.groupKey,
      depth: 0,
      current: group.current,
      running: sessionsRunning > 0 || agentsRunning > 0,
      label: group.title,
      meta: metaParts.join(' · '),
      description: [path, ...metaParts].filter((part) => part !== '').join(' · '),
    });
    sortChildren(group.children);
    for (const session of group.children) pushSession(session, group);
  }
  return items;
}
