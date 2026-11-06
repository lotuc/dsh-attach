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

export const LOCAL_COMMAND_SPECS = Object.freeze([
  { name: 'help', description: 'Show keys and commands' },
  {
    name: 'session',
    description: 'List, create, resume or rename sessions',
    argumentHint: '[list|new [cwd]|resume [id]|rename <title>]',
    completion: 'group',
  },
  { name: 'reconnect', description: 'Reconnect to the Host and reopen the session' },
  {
    name: 'subagent',
    description: 'List, preview or navigate subagents',
    argumentHint: '[list|preview [count]|parent|peek]',
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
  { name: 'cancel', description: 'Cancel the running turn' },
  { name: 'steer', description: 'Interrupt the turn and steer it', argumentHint: '<text>' },
  { name: 'queue', description: 'Queue a message, or manage pending messages', argumentHint: '[text]' },
  { name: 'find', description: 'Search the loaded transcript', argumentHint: '[text]' },
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
export function localCommandItems(client) {
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
          getArgumentCompletions: (prefix) => groupedCompletions(command.name, prefix, client),
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
    { value: 'preview ', label: 'preview [count]', description: 'Open running subagents in Herdr panes' },
    { value: 'parent', label: 'parent', description: 'Open the parent session' },
    { value: 'peek', label: 'peek', description: 'Toggle the bounded subagent peek' },
  ],
  session: [
    { value: 'list', label: 'list', description: 'Pick a session' },
    { value: 'new ', label: 'new [cwd]', description: 'Create a session' },
    { value: 'resume ', label: 'resume [id]', description: 'Resume a session' },
    { value: 'rename ', label: 'rename <title>', description: 'Rename the current session' },
  ],
  skill: [
    { value: 'list', label: 'list', description: 'List available user skills' },
    { value: 'show ', label: 'show <name>', description: 'Show skill instructions' },
    { value: 'run ', label: 'run <name>', description: 'Invoke a skill in the next prompt' },
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
export async function groupedCompletions(name, argumentText, client) {
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
  if (name === 'session' && subcommand === 'resume') {
    const items = await resumeCompletions(client, rest);
    return items.map((item) => ({
      value: `resume ${item.value}`,
      label: `resume ${item.label}`,
      description: item.description,
    }));
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
 * Session suggestions for `/resume`.
 * @param {{request(method: string, params?: object): Promise<any>}} client
 * @param {string} prefix
 * @returns {Promise<Array<{value: string, label: string, description: string}>>}
 */
export async function resumeCompletions(client, prefix) {
  try {
    const value = await client.request('session.list');
    const needle = String(prefix ?? '').trim().toLowerCase();
    return (value?.items ?? [])
      .filter((item) => item.origin !== 'subagent' && item.blank !== true)
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
