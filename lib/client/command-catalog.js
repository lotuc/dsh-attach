/**
 * Slash-command catalog for the attach client.
 *
 * Local commands are handled by the TUI itself. Host commands are discovered
 * from `ctx.commands` and executed by the Host, so their effects stay inside
 * the running Harness rather than becoming model prompts.
 *
 * The catalog is also the autocomplete source: grouped commands complete
 * their subcommands, `/session resume` completes Session titles/ids, and
 * `/model` completes provider/model pairs.
 */

import { sanitizeText, oneLine } from './transcript.js';
import { PERMISSION_PRESETS } from './permission-presets.js';
import { DETAIL_LEVELS } from './detail-level.js';

export const LOCAL_COMMAND_SPECS = Object.freeze([
  { name: 'help', description: 'Show keys and commands' },
  {
    name: 'session',
    description: 'List, create, resume, fork, archive, pin or preset sessions',
    argumentHint: '[list|new [cwd] [--preset <id>]|resume [id]|rename <title>|fork [id]|archive [id] [--stop]|unarchive <id>|pin [id]|unpin [id]|presets|preset [id]|delete [id]]',
    completion: 'group',
  },
  { name: 'reconnect', description: 'Reconnect to the Host and reopen the session' },
  {
    name: 'subagent',
    description: 'List, control, preview or navigate subagents',
    argumentHint: '[list|continue [id] [text]|interrupt [id]|stop [id]|cancel [id]|preview [count]|parent|peek]',
    completion: 'group',
  },
  {
    name: 'image',
    description: 'Paste, list or clear clipboard images',
    argumentHint: '[paste|list|clear]',
    completion: 'group',
  },
  {
    name: 'job',
    description: 'List, open or stop background jobs',
    argumentHint: '[list|output <id>|kill <id>]',
    completion: 'group',
  },
  {
    name: 'skill',
    description: 'List, inspect or run a skill',
    argumentHint: '[list|show <name>|run <name>]',
    completion: 'group',
  },
  { name: 'todo', description: 'Show the current todo list' },
  { name: 'detail', description: 'Set transcript detail level', argumentHint: '[compact|standard|verbose]', completion: 'detail' },
  {
    name: 'goal',
    description: 'Show or manage the session goal',
    argumentHint: '[status|create <objective>|edit [objective]|pause|resume|complete|clear]',
    completion: 'group',
  },
  {
    name: 'plan',
    description: 'Enter, leave or inspect plan mode',
    argumentHint: '[status|enter [message]|exit]',
    completion: 'group',
  },
  { name: 'cancel', description: 'Cancel the running turn' },
  { name: 'steer', description: 'Interrupt the turn and steer it', argumentHint: '<text>' },
  { name: 'queue', description: 'Queue a message, or manage pending messages', argumentHint: '[text]' },
  { name: 'find', description: 'Search the loaded transcript', argumentHint: '[text]' },
  { name: 'history', description: 'Load the next older page of session history' },
  { name: 'model', description: 'Select provider/model', argumentHint: '<provider> <model>', completion: 'model' },
  { name: 'permission', description: 'Select the sandbox permission preset', argumentHint: '[mode]', completion: 'permission' },
  { name: 'status', description: 'Show session status' },
  { name: 'quit', description: 'Exit the attach client' },
]);

function matches(haystack, needle) {
  return needle === '' || haystack.toLowerCase().includes(needle);
}

/** Explicit descriptions for Host subcommands whose hints are terse. */
const HOST_ARGUMENT_DESCRIPTIONS = Object.freeze({
  goal: {
    clear: 'Clear the current goal',
    complete: 'Mark the current goal complete',
    edit: 'Replace the goal objective',
    pause: 'Pause the current goal',
    resume: 'Resume a paused goal',
  },
  plan: {
    off: 'Leave plan mode',
    message: 'Enter plan mode for the next message',
  },
});

/** Values that are not expressible as `[a|b]` alternatives in the Host hint. */
const HOST_ARGUMENT_VALUES = Object.freeze({
  permission: PERMISSION_PRESETS,
});

/**
 * Build argument completions from a Host command's bracket alternatives.
 * A bare `<placeholder>` is free text and does not become a selectable item.
 */
export function hostArgumentCompletions(command, prefix = '') {
  const text = String(prefix ?? '').trimStart();
  if (text.includes(' ')) return [];
  const explicit = HOST_ARGUMENT_VALUES[command.name];
  if (explicit !== undefined) {
    return explicit
      .filter((item) => text === '' || item.label.toLowerCase().startsWith(text.toLowerCase()))
      .slice(0, 20);
  }
  const hint = typeof command?.argumentHint === 'string' ? command.argumentHint.trim() : '';
  if (!hint.startsWith('[') || !hint.endsWith(']')) return [];
  const descriptions = HOST_ARGUMENT_DESCRIPTIONS[command.name] ?? {};
  return hint
    .slice(1, -1)
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !part.startsWith('<'))
    .map((part) => {
      const [word, ...rest] = part.split(/\s+/u);
      const value = rest.length === 0 ? word : `${word} `;
      return {
        value,
        label: part,
        description: descriptions[word] ?? '',
      };
    })
    .filter((item) => text === '' || item.label.toLowerCase().startsWith(text.toLowerCase()))
    .slice(0, 20);
}

/**
 * Build pi-tui SlashCommand items for the local command set.
 * @param {{request(method: string, params?: object): Promise<any>}} client
 * @returns {Array<object>}
 */
export function localCommandItems(client, { sessionId = null } = {}) {
  return LOCAL_COMMAND_SPECS.map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
    ...(command.completion === 'resume'
      ? {
          getArgumentCompletions: (prefix) => resumeCompletions(client, prefix),
        }
      : {}),
    ...(command.completion === 'model'
      ? {
          getArgumentCompletions: (prefix) => modelCompletions(client, prefix),
        }
      : {}),
    ...(command.completion === 'permission'
      ? {
          getArgumentCompletions: (prefix) => permissionCompletions(prefix),
        }
      : {}),
    ...(command.completion === 'group'
      ? {
          getArgumentCompletions: (prefix) => groupedCompletions(command.name, prefix, client, { sessionId }),
        }
      : {}),
    ...(command.completion === 'detail'
      ? {
          getArgumentCompletions: (prefix) => detailCompletions(prefix),
        }
      : {}),
  }));
}

const GROUP_SUBCOMMANDS = Object.freeze({
  image: [
    { value: 'paste', label: 'paste', description: 'Attach an image from the clipboard' },
    { value: 'list', label: 'list', description: 'Show attached images' },
    { value: 'clear', label: 'clear', description: 'Clear attached images' },
  ],
  job: [
    { value: 'list', label: 'list', description: 'List background jobs' },
    { value: 'output ', label: 'output <id>', description: 'Open background job output' },
    { value: 'kill ', label: 'kill <id>', description: 'Stop a background job' },
  ],
  subagent: [
    { value: 'list', label: 'list', description: 'List subagents' },
    { value: 'continue ', label: 'continue [id] [text]', description: 'Send a follow-up to a continuable subagent' },
    { value: 'interrupt ', label: 'interrupt [id]', description: 'Stop a running subagent after confirmation' },
    { value: 'stop ', label: 'stop [id]', description: 'Alias for interrupt' },
    { value: 'cancel ', label: 'cancel [id]', description: 'Alias for interrupt' },
    { value: 'preview ', label: 'preview [count]', description: 'Open running subagents in Herdr panes' },
    { value: 'parent', label: 'parent', description: 'Open the parent session' },
    { value: 'peek', label: 'peek', description: 'Toggle the bounded subagent peek' },
  ],
  session: [
    { value: 'list', label: 'list', description: 'Pick a session' },
    { value: 'new ', label: 'new [cwd] [--preset <id>]', description: 'Create a session' },
    { value: 'resume ', label: 'resume [id]', description: 'Resume a session' },
    { value: 'rename ', label: 'rename <title>', description: 'Rename the current session' },
    { value: 'fork ', label: 'fork [id]', description: 'Fork a session and open the child' },
    { value: 'archive ', label: 'archive [id] [--stop]', description: 'Archive a session' },
    { value: 'unarchive ', label: 'unarchive <id>', description: 'Restore an archived session' },
    { value: 'pin ', label: 'pin [id]', description: 'Pin a session' },
    { value: 'unpin ', label: 'unpin [id]', description: 'Unpin a session' },
    { value: 'presets', label: 'presets', description: 'Show the Host agent-preset roster' },
    { value: 'preset ', label: 'preset [id]', description: 'Choose the preset for new sessions' },
  ],
  skill: [
    { value: 'list', label: 'list', description: 'List available user skills' },
    { value: 'show ', label: 'show <name>', description: 'Show skill instructions' },
    { value: 'run ', label: 'run <name>', description: 'Invoke a skill in the next prompt' },
  ],
  goal: [
    { value: 'status', label: 'status', description: 'Show phase, rounds, activation and next actions' },
    { value: 'create ', label: 'create <objective>', description: 'Create and arm a new goal' },
    { value: 'edit ', label: 'edit [objective]', description: 'Edit the current objective' },
    { value: 'pause', label: 'pause', description: 'Pause the goal and disarm continuation' },
    { value: 'resume', label: 'resume', description: 'Resume or rearm a stopped goal' },
    { value: 'complete', label: 'complete', description: 'Mark the goal complete (asks first)' },
    { value: 'clear', label: 'clear', description: 'Clear the goal (asks first)' },
  ],
  plan: [
    { value: 'status', label: 'status', description: 'Show plan mode and pending state' },
    { value: 'enter ', label: 'enter [message]', description: 'Enter plan mode, optionally with a message' },
    { value: 'exit', label: 'exit', description: 'Leave plan mode' },
    { value: 'approve', label: 'approve', description: 'Approve in the plan-review panel when one is open' },
  ],
});

function groupSubcommands(name) {
  return GROUP_SUBCOMMANDS[name] ?? [];
}

async function jobIdCompletions(client, subcommand, rest) {
  try {
    const value = await client.request('job.list');
    const needle = String(rest ?? '').trim().toLowerCase();
    return (Array.isArray(value?.jobs) ? value.jobs : [])
      .filter((job) => {
        const id = String(job?.id ?? '');
        return id !== '' && (needle === '' || `${id} ${job.label ?? ''}`.toLowerCase().includes(needle));
      })
      .slice(0, 30)
      .map((job) => ({
        value: `${subcommand} ${String(job.id)}`,
        label: `${subcommand} ${String(job.id)}`,
        description: `${job.kind ?? 'job'} · ${job.status ?? 'unknown'}${typeof job.label === 'string' && job.label !== '' ? ` · ${oneLine(job.label, 60)}` : ''}`,
      }));
  } catch {
    return [];
  }
}

/**
 * Argument completions for grouped local commands such as `/job output <id>`.
 * @param {string} name
 * @param {string} argumentText
 * @param {{request(method: string, params?: object): Promise<any>}} client
 * @returns {Promise<Array<{value: string, label: string, description: string}>>}
 */
export async function groupedCompletions(name, argumentText, client, { sessionId = null } = {}) {
  const commands = groupSubcommands(name);
  if (commands.length === 0) return [];
  const text = String(argumentText ?? '');
  const trimmed = text.trimStart();
  const firstSpace = trimmed.search(/\s/u);
  if (firstSpace < 0) {
    const needle = trimmed.toLowerCase();
    return commands
      .filter((item) => item.value.trim().startsWith(needle) || item.label.toLowerCase().startsWith(needle))
      .slice(0, 20)
      .map((item) => ({ ...item }));
  }

  const subcommand = trimmed.slice(0, firstSpace).toLowerCase();
  const rest = trimmed.slice(firstSpace + 1);
  if (name === 'job' && (subcommand === 'output' || subcommand === 'kill')) {
    return jobIdCompletions(client, subcommand, rest);
  }
  if (name === 'session') {
    if (subcommand === 'new') {
      const text = rest.trimStart();
      const preset = /^--preset(?:=|\s+)?(.*)$/u.exec(text);
      if (text === '' || preset !== null) {
        return presetCompletions(client, preset === null ? '' : preset[1], { subcommand: 'new --preset' });
      }
      return [];
    }
    if (subcommand === 'preset') {
      return presetCompletions(client, rest, { subcommand: 'preset' });
    }
    const archived = subcommand === 'archive' || subcommand === 'pin' || subcommand === 'unpin'
      ? 'exclude'
      : 'all';
    if (['resume', 'fork', 'archive', 'unarchive', 'pin', 'unpin'].includes(subcommand)) {
      const items = await sessionTargetCompletions(client, rest, { archived });
      return items.map((item) => ({
        value: `${subcommand} ${item.value}`,
        label: `${subcommand} ${item.label}`,
        description: item.description,
      }));
    }
  }
  if (name === 'subagent' && ['continue', 'interrupt', 'stop', 'cancel'].includes(subcommand)) {
    return subagentTargetCompletions(client, subcommand, rest, sessionId);
  }
  if (name === 'subagent' && subcommand === 'preview') {
    const needle = rest.trim();
    return [
      { value: 'preview 1', label: 'preview 1', description: 'Open one running subagent' },
      { value: 'preview 2', label: 'preview 2', description: 'Open up to two running subagents' },
    ].filter((item) => needle === '' || item.value.endsWith(needle));
  }
  if (name === 'skill' && (subcommand === 'show' || subcommand === 'run')) {
    return skillCompletions(client, subcommand, rest);
  }
  return [];
}

async function subagentTargetCompletions(client, subcommand, prefix, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return [];
  try {
    const value = await client.request('subagent.list', { sessionId });
    const needle = String(prefix ?? '').trim().toLowerCase();
    return (value?.supported === true && Array.isArray(value.items) ? value.items : [])
      .filter((item) => item?.kind === 'child' && typeof item.id === 'string' && item.id !== '')
      .filter((item) => needle === '' || `${item.id} ${item.label ?? ''} ${item.title ?? ''}`.toLowerCase().includes(needle))
      .slice(0, 30)
      .map((item) => ({
        value: `${subcommand} ${item.id}`,
        label: `${subcommand} ${sanitizeText(item.label ?? item.title ?? item.id)}`,
        description: sanitizeText([item.mode, item.activity].filter((part) => typeof part === 'string' && part !== '').join(' · ')),
      }));
  } catch {
    return [];
  }
}

async function skillCompletions(client, subcommand, prefix) {
  try {
    const value = await client.request('skill.list');
    const needle = String(prefix ?? '').trim().toLowerCase();
    return (Array.isArray(value?.skills) ? value.skills : [])
      .filter((skill) => typeof skill?.name === 'string' && skill.name !== '')
      .filter((skill) => needle === '' || `${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(needle))
      .slice(0, 40)
      .map((skill) => ({
        value: `${subcommand} ${skill.name}`,
        label: `${subcommand} ${skill.name}`,
        description: sanitizeText(oneLine(skill.description ?? '', 100)),
      }));
  } catch {
    return [];
  }
}

/**
 * Detail levels for `/detail` and `Ctrl+G`.
 * @param {string} prefix
 * @returns {Array<{value: string, label: string, description: string}>}
 */
export function detailCompletions(prefix = '') {
  const text = String(prefix ?? '').trim().toLowerCase();
  const descriptions = {
    compact: 'Fold running and completed turn work',
    standard: 'Open the running turn, fold completed turns',
    verbose: 'Expand turn work, tools, and reasoning',
  };
  return DETAIL_LEVELS
    .filter((level) => text === '' || level.startsWith(text))
    .map((level) => ({ value: level, label: level, description: descriptions[level] }));
}

/**
 * Sandbox presets for `/permission`.
 * @param {string} prefix
 * @returns {Array<{value: string, label: string, description: string}>}
 */
export function permissionCompletions(prefix = '') {
  const text = String(prefix ?? '').trim().toLowerCase();
  return PERMISSION_PRESETS
    .filter((item) => text === '' || item.value.toLowerCase().startsWith(text))
    .slice(0, 20)
    .map((item) => ({ value: item.value, label: item.label, description: item.description }));
}

/**
 * User-invocable skills as extra slash commands. Names that collide with a
 * local or Host command are omitted because command adjudication wins.
 * @param {Array<{name?: string, description?: string}>} skills
 * @param {Set<string>} reserved
 * @returns {Array<object>}
 */
export function skillCommandItems(skills, reserved = new Set()) {
  return (Array.isArray(skills) ? skills : [])
    .filter((skill) => typeof skill?.name === 'string' && /^[a-z0-9][a-z0-9-]*$/u.test(skill.name))
    .filter((skill) => !reserved.has(skill.name))
    .slice(0, 200)
    .map((skill) => ({
      name: skill.name,
      description: sanitizeText(oneLine(skill.description ?? 'Skill', 120)),
    }));
}

/**
 * Merge Host command descriptors after the local catalog, dropping duplicates.
 * @param {Array<object>} local
 * @param {Array<{name: string, description?: string, argumentHint?: string}>} host
 * @returns {Array<object>}
 */
export function mergeHostCommands(local, host) {
  const seen = new Set(local.map((command) => command.name));
  const merged = [...local];
  for (const command of Array.isArray(host) ? host : []) {
    if (typeof command?.name !== 'string' || !/^[a-z0-9_-]+$/u.test(command.name) || seen.has(command.name)) continue;
    seen.add(command.name);
    const argumentHint = typeof command.argumentHint === 'string' && command.argumentHint !== ''
      ? sanitizeText(command.argumentHint)
      : undefined;
    const completions = hostArgumentCompletions({ ...command, argumentHint });
    merged.push({
      name: command.name,
      description: typeof command.description === 'string' ? sanitizeText(command.description) : '',
      ...(argumentHint === undefined ? {} : { argumentHint }),
      ...(completions.length === 0 ? {} : {
        getArgumentCompletions: (prefix) => hostArgumentCompletions({ ...command, argumentHint }, prefix),
      }),
    });
  }
  return merged;
}

/**
 * Session suggestions shared by resume/fork/archive/pin.
 * @param {{request(method: string, params?: object): Promise<any>}} client
 * @param {string} prefix
 * @param {{archived?: 'all'|'exclude'|'only'}} [options] - archive filter
 * @returns {Promise<Array<{value: string, label: string, description: string}>>}
 */
export async function sessionTargetCompletions(client, prefix, { archived = 'exclude' } = {}) {
  try {
    const value = await client.request('session.list');
    let archivedIds = new Set();
    if (archived !== 'all') {
      const workspace = await client.request('workspace.list').catch(() => ({ archivedSessionIds: [] }));
      archivedIds = new Set((workspace?.archivedSessionIds ?? []).map(String));
    }
    const needle = String(prefix ?? '').trim().toLowerCase();
    return (value?.items ?? [])
      .filter((item) => item.origin !== 'subagent' && item.blank !== true)
      .filter((item) => {
        if (archived === 'all') return true;
        const isArchived = archivedIds.has(String(item.sessionId));
        return archived === 'only' ? isArchived : !isArchived;
      })
      .filter((item) => matches(`${item.title ?? ''} ${item.cwd ?? ''} ${item.sessionId}`, needle))
      .slice(0, 30)
      .map((item) => ({
        value: item.sessionId,
        label: sanitizeText(typeof item.title === 'string' && item.title !== '' ? item.title : `(untitled) ${item.sessionId.slice(0, 8)}`),
        description: sanitizeText([item.cwd, item.sessionId.slice(0, 8)].filter((part) => typeof part === 'string' && part !== '').join(' · ')),
      }));
  } catch {
    return [];
  }
}

/**
 * Session suggestions for `/resume`.
 * @param {{request(method: string, params?: object): Promise<any>}} client
 * @param {string} prefix
 * @returns {Promise<Array<{value: string, label: string, description: string}>>}
 */
export async function resumeCompletions(client, prefix) {
  return sessionTargetCompletions(client, prefix, { archived: 'all' });
}

/**
 * Agent-preset suggestions for `/session preset` and `/session new --preset`.
 * @param {{request(method: string, params?: object): Promise<any>}} client
 * @param {string} prefix
 * @param {{subcommand?: string}} [options] - text inserted before the preset id
 * @returns {Promise<Array<{value: string, label: string, description: string}>>}
 */
export async function presetCompletions(client, prefix = '', { subcommand = 'preset' } = {}) {
  try {
    const value = await client.request('session.presets');
    if (value?.supported !== true || !Array.isArray(value.presets)) return [];
    const needle = String(prefix ?? '').trim().toLowerCase();
    return value.presets
      .filter((preset) => preset !== null && typeof preset === 'object' && typeof preset.id === 'string' && preset.id !== '')
      .filter((preset) => needle === '' || `${preset.id} ${preset.name ?? ''}`.toLowerCase().includes(needle))
      .slice(0, 50)
      .map((preset) => {
        const markers = [preset.isDefault === true ? 'default' : '', preset.broken ? 'unavailable' : ''].filter(Boolean).join(' · ');
        return {
          value: `${subcommand} ${preset.id}`,
          label: sanitizeText(`${subcommand} ${preset.name ?? preset.id}`),
          description: sanitizeText([preset.description, markers].filter((part) => typeof part === 'string' && part !== '').join(' · ')),
        };
      });
  } catch {
    return [];
  }
}

/**
 * Provider/model suggestions for `/model`.
 * @param {{request(method: string, params?: object): Promise<any>}} client
 * @param {string} prefix
 * @returns {Promise<Array<{value: string, label: string, description: string}>>}
 */
export async function modelCompletions(client, prefix) {
  try {
    const catalog = await client.request('model.catalog');
    const needle = String(prefix ?? '').trim().toLowerCase();
    const items = [];
    for (const group of catalog?.groups ?? []) {
      for (const model of group.models ?? []) {
        const label = `${group.id}/${model.id}`;
        if (matches(`${label} ${model.name ?? ''}`, needle)) {
          items.push({
            value: `${group.id} ${model.id}`,
            label: sanitizeText(label),
            description: sanitizeText(typeof model.name === 'string' ? model.name : ''),
          });
        }
      }
    }
    return items.slice(0, 50);
  } catch {
    return [];
  }
}
