/** Map a running tool to the short live-process label DSH shows. */
export function describeToolActivity(name, detail = '') {
  const tool = String(name ?? '').toLowerCase();
  const text = String(detail ?? '').trim();
  if (tool === 'bash' || tool === 'shell' || tool === 'exec' || tool === 'exec_command' || tool === 'run_command') {
    return { kind: 'commands', detail: text };
  }
  if (tool === 'read' || tool === 'read_file' || tool === 'cat') return { kind: 'read', detail: text };
  if (tool === 'view' || tool === 'read_image') return { kind: 'readImage', detail: text };
  if (tool === 'write' || tool === 'write_file' || tool === 'create_file') return { kind: 'write', detail: text };
  if (tool === 'edit' || tool === 'replace' || tool === 'apply_patch' || tool === 'patch' || tool === 'str_replace_editor') {
    return { kind: 'edit', detail: text };
  }
  if (tool === 'grep' || tool === 'glob' || tool === 'search' || tool === 'find' || tool === 'fs_search') {
    return { kind: 'search', detail: text };
  }
  if (tool === 'web_search') return { kind: 'webSearch', detail: text };
  if (tool === 'web_fetch') return { kind: 'webFetch', detail: text };
  if (tool === 'subagent' || tool === 'spawn_teammate' || tool === 'send_message' || tool === 'wait_agent' || tool === 'interrupt_agent') {
    return { kind: 'subagents', detail: text };
  }
  if (tool === 'todo' || tool === 'todo_write' || tool === 'plan') return { kind: 'plan', detail: text };
  if (tool === 'skill') return { kind: 'read', detail: text };
  return { kind: 'preparing', detail: text === '' ? '' : `${tool} · ${text}` };
}

const LABELS = Object.freeze({
  thinking: 'Analyzing the request',
  preparing: 'Preparing',
  commands: 'Running commands',
  read: 'Reading files',
  readImage: 'Reading images',
  write: 'Writing files',
  edit: 'Editing files',
  search: 'Searching code',
  webSearch: 'Searching the web',
  webFetch: 'Visiting web pages',
  subagents: 'Coordinating subagents',
  plan: 'Updating the plan',
  questions: 'Waiting for your action',
});

/** Human-readable live activity phrase for a running turn. */
export function liveActivityLabel(activity, detail = '') {
  const label = LABELS[activity] ?? LABELS.preparing;
  const text = String(detail ?? '').trim();
  return text === '' ? label : `${label} · ${text}`;
}
