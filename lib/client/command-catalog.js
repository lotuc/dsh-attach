/**
 * Slash-command catalog for the attach client.
 *
 * Local commands are handled by the TUI itself. Host commands are discovered
 * from `ctx.commands` and executed by the Host, so their effects stay inside
 * the running Harness rather than becoming model prompts.
 *
 * The catalog is also the autocomplete source: `/resume` completes Session
 * titles/ids and `/model` completes provider/model pairs.
 */

import { sanitizeText } from './transcript.js';

export const LOCAL_COMMAND_SPECS = Object.freeze([
  { name: 'help', description: 'Show keys and commands' },
  { name: 'sessions', description: 'Pick a session' },
  { name: 'reconnect', description: 'Reconnect to the Host and reopen the session' },
  { name: 'subagents', description: 'List subagents under this session' },
  { name: 'subagents-preview', description: 'Open running subagents in managed Herdr panes', argumentHint: '[count]' },
  { name: 'peek', description: 'Toggle the bounded subagent peek' },
  { name: 'paste-image', description: 'Attach an image from the system clipboard' },
  { name: 'images', description: 'Show or clear attached clipboard images', argumentHint: '[clear]' },
  { name: 'jobs', description: 'List background jobs' },
  { name: 'job-output', description: 'Open background job output', argumentHint: '<id>' },
  { name: 'job-kill', description: 'Stop a background job', argumentHint: '<id>' },
  { name: 'parent', description: 'Open the parent session' },
  { name: 'new', description: 'Create a new session', argumentHint: '[cwd]' },
  { name: 'resume', description: 'Resume a session', argumentHint: '<id>', completion: 'resume' },
  { name: 'rename', description: 'Rename the current session', argumentHint: '<title>' },
  { name: 'cancel', description: 'Cancel the running turn' },
  { name: 'steer', description: 'Interrupt the turn and steer it', argumentHint: '<text>' },
  { name: 'queue', description: 'Queue a message, or manage pending messages', argumentHint: '[text]' },
  { name: 'model', description: 'Select provider/model', argumentHint: '<provider> <model>', completion: 'model' },
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

/**
 * Build argument completions from a Host command's bracket alternatives.
 * A bare `<placeholder>` is free text and does not become a selectable item.
 */
export function hostArgumentCompletions(command, prefix = '') {
  const hint = typeof command?.argumentHint === 'string' ? command.argumentHint.trim() : '';
  if (!hint.startsWith('[') || !hint.endsWith(']')) return [];
  const text = String(prefix ?? '').trimStart();
  if (text.includes(' ')) return [];
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
