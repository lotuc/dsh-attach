/**
 * Local slash-command routing.
 *
 * The handlers live in AttachApp because they need terminal panels, sockets,
 * and session state. This module owns parsing and the dispatch table so the
 * command surface can be tested without constructing a TUI.
 */

import { parseGoalCommand } from './goal.js';
import { parsePlanCommand } from './plan.js';

/** Split a slash command into its lower-case name and argument text. */
export function parseLocalCommand(line) {
  const text = String(line ?? '').trim();
  const [rawName = ''] = text.split(/\s+/u);
  return {
    name: rawName.toLowerCase(),
    rest: text.slice(rawName.length).trim(),
  };
}


function splitGroup(rest) {
  const text = String(rest ?? '').trim();
  if (text === '') return { sub: '', arg: '' };
  const [sub = '', ...parts] = text.split(/\s+/u);
  return { sub: sub.toLowerCase(), arg: parts.join(' ') };
}

function usage(context, line) {
  context.note(`usage: ${line}`, 'warn');
}

async function executeImageGroup(rest, context) {
  const { sub } = splitGroup(rest);
  if (sub === '' || sub === 'list') {
    context.images();
    return;
  }
  if (sub === 'paste') {
    await context.pasteImage();
    return;
  }
  if (sub === 'clear') {
    context.clearImages();
    return;
  }
  usage(context, '/image [paste|list|clear]');
}

async function executeJobGroup(rest, context) {
  const { sub, arg } = splitGroup(rest);
  if (sub === '' || sub === 'list') {
    await context.jobs();
    return;
  }
  if (sub === 'output') {
    if (arg === '') usage(context, '/job output <job-id>');
    else await context.jobOutput(arg);
    return;
  }
  if (sub === 'kill') {
    if (arg === '') usage(context, '/job kill <job-id>');
    else await context.killJob(arg);
    return;
  }
  usage(context, '/job [list|output <id>|kill <id>]');
}

async function executeSubagentGroup(rest, context) {
  const { sub, arg } = splitGroup(rest);
  if (sub === '' || sub === 'list') {
    await context.agents();
    return;
  }
  if (sub === 'preview') {
    await context.previewAgents(arg);
    return;
  }
  if (sub === 'parent') {
    await context.parent();
    return;
  }
  if (sub === 'peek') {
    context.togglePeek();
    return;
  }
  if (sub === 'continue') {
    await context.continueAgent(arg);
    return;
  }
  if (sub === 'interrupt' || sub === 'stop' || sub === 'cancel') {
    await context.interruptAgent(arg);
    return;
  }
  usage(context, '/subagent [list|continue [id] [text]|interrupt [id]|stop [id]|cancel [id]|preview [count]|parent|peek]');
}

/**
 * Parse `/session new` arguments without breaking a cwd that contains spaces.
 * The only supported option is `--preset <id>` (or `--preset=<id>`).
 * @param {string} rest
 * @returns {{cwd: string, agentPreset: string, invalid: boolean}}
 */
export function parseNewSessionArgs(rest) {
  let text = String(rest ?? '').trim();
  let agentPreset = '';
  const preset = /(?:^|\s)--preset(?:=|\s+)(\S+)/u.exec(text);
  if (preset !== null) {
    const value = preset[1];
    if (value.startsWith('--')) return { cwd: '', agentPreset: '', invalid: true };
    agentPreset = value;
    text = `${text.slice(0, preset.index)} ${text.slice(preset.index + preset[0].length)}`.trim();
  } else if (/(?:^|\s)--preset(?:\s|$)/u.test(text)) {
    return { cwd: '', agentPreset: '', invalid: true };
  }
  if (text.startsWith('--') || /\s--\S/u.test(text)) {
    return { cwd: '', agentPreset: '', invalid: true };
  }
  return { cwd: text, agentPreset, invalid: false };
}

/**
 * Parse `/session archive` arguments: an optional id and the `--stop` flag.
 * @param {string} rest
 * @returns {{sessionId: string, stopActivity: boolean, invalid: boolean}}
 */
export function parseSessionArchiveArgs(rest) {
  let text = String(rest ?? '').trim();
  const stopActivity = /(?:^|\s)--stop(?:\s|$)/u.test(text);
  text = text.replace(/(?:^|\s)--stop(?=\s|$)/u, ' ').trim();
  if (text.startsWith('--') || /\s--\S/u.test(text)) {
    return { sessionId: '', stopActivity, invalid: true };
  }
  return { sessionId: text, stopActivity, invalid: false };
}

async function executeSessionGroup(rest, context) {
  const { sub, arg } = splitGroup(rest);
  if (sub === '' || sub === 'list') {
    await context.sessions();
    return;
  }
  if (sub === 'new') {
    const parsed = parseNewSessionArgs(arg);
    if (parsed.invalid) {
      usage(context, '/session new [cwd] [--preset <id>]');
    } else if (parsed.agentPreset === '') {
      await context.newSession(parsed.cwd);
    } else {
      await context.newSession(parsed.cwd, { agentPreset: parsed.agentPreset });
    }
    return;
  }
  if (sub === 'resume') {
    if (arg === '') await context.sessions();
    else await context.openSession(arg);
    return;
  }
  if (sub === 'rename') {
    if (arg === '') usage(context, '/session rename <title>');
    else await context.rename(arg);
    return;
  }
  if (sub === 'fork') {
    await context.forkSession(arg);
    return;
  }
  if (sub === 'archive') {
    const parsed = parseSessionArchiveArgs(arg);
    if (parsed.invalid) usage(context, '/session archive [id] [--stop]');
    else await context.archiveSession(parsed.sessionId, { stopActivity: parsed.stopActivity });
    return;
  }
  if (sub === 'unarchive') {
    if (arg === '') usage(context, '/session unarchive <id>');
    else await context.unarchiveSession(arg);
    return;
  }
  if (sub === 'pin') {
    await context.pinSession(arg);
    return;
  }
  if (sub === 'unpin') {
    await context.unpinSession(arg);
    return;
  }
  if (sub === 'presets') {
    await context.sessionPresets();
    return;
  }
  if (sub === 'preset') {
    if (arg === '') await context.sessionPresetPicker();
    else await context.sessionPreset(arg);
    return;
  }
  if (sub === 'delete') {
    await context.deleteSession(arg);
    return;
  }
  usage(context, '/session [list|new [cwd] [--preset <id>]|resume [id]|rename <title>|fork [id]|archive [id] [--stop]|unarchive <id>|pin [id]|unpin [id]|presets|preset [id]|delete [id]]');
}


async function executeGoalGroup(rest, context) {
  await context.goal(parseGoalCommand(rest));
}

async function executePlanGroup(rest, context) {
  await context.plan(parsePlanCommand(rest));
}

async function executeSkillGroup(rest, context) {
  const { sub, arg } = splitGroup(rest);
  if (sub === '' || sub === 'list') {
    await context.skillsList();
    return;
  }
  if (sub === 'show') {
    if (arg === '') usage(context, '/skill show <name>');
    else await context.skillShow(arg);
    return;
  }
  if (sub === 'run') {
    if (arg === '') usage(context, '/skill run <name>');
    else await context.skillRun(arg);
    return;
  }
  usage(context, '/skill [list|show <name>|run <name>]');
}

/**
 * Execute one local command.
 *
 * @param {string} line
 * @param {object} context
 * @returns {Promise<boolean>} true when a local command handled the line
 */
export async function executeLocalCommand(line, context) {
  const { name, rest } = parseLocalCommand(line);
  switch (name) {
    case '/help':
      context.help();
      return true;
    case '/session':
      await executeSessionGroup(rest, context);
      return true;
    case '/sessions':
      await executeSessionGroup(rest, context);
      return true;
    case '/reconnect':
      await context.reconnect();
      return true;
    case '/subagent':
      await executeSubagentGroup(rest, context);
      return true;
    case '/subagents':
    case '/agents':
      await executeSubagentGroup(rest, context);
      return true;
    case '/image':
      await executeImageGroup(rest, context);
      return true;
    case '/job':
      await executeJobGroup(rest, context);
      return true;
    case '/skill':
      await executeSkillGroup(rest, context);
      return true;
    case '/goal':
      await executeGoalGroup(rest, context);
      return true;
    case '/plan':
      await executePlanGroup(rest, context);
      return true;
    case '/todo':
    case '/todos':
      context.todos();
      return true;
    case '/detail':
      await context.detail(rest);
      return true;
    case '/btw':
      await context.btw(rest);
      return true;
    case '/auto':
      await context.auto(rest);
      return true;
    case '/jobs':
      await executeJobGroup(rest, context);
      return true;
    case '/job-output':
      if (rest === '') context.note('usage: /job-output <job-id>', 'warn');
      else await context.jobOutput(rest);
      return true;
    case '/job-kill':
      if (rest === '') context.note('usage: /job-kill <job-id>', 'warn');
      else await context.killJob(rest);
      return true;
    case '/subagents-preview':
    case '/agents-preview':
      await context.previewAgents(rest);
      return true;
    case '/peek':
      context.togglePeek();
      return true;
    case '/paste-image':
      await context.pasteImage();
      return true;
    case '/images': {
      const { sub } = splitGroup(rest);
      if (sub === '' || sub === 'list') context.images();
      else if (sub === 'clear') context.clearImages();
      else usage(context, '/images [list|clear]');
      return true;
    }
    case '/parent':
      await context.parent();
      return true;
    case '/resume':
      if (rest === '') await context.sessions();
      else await context.openSession(rest);
      return true;
    case '/new': {
      const parsed = parseNewSessionArgs(rest);
      if (parsed.invalid) usage(context, '/new [cwd] [--preset <id>]');
      else if (parsed.agentPreset === '') await context.newSession(parsed.cwd);
      else await context.newSession(parsed.cwd, { agentPreset: parsed.agentPreset });
      return true;
    }
    case '/rename':
      if (rest === '') context.note('usage: /rename <title>', 'warn');
      else await context.rename(rest);
      return true;
    case '/cancel':
      await context.cancel();
      return true;
    case '/steer':
      if (rest === '') context.note('usage: /steer <text>', 'warn');
      else await context.submitPrompt(rest, 'steer');
      return true;
    case '/queue':
      if (rest === '') await context.queueManager();
      else await context.submitPrompt(rest, 'queue');
      return true;
    case '/find':
      context.find(rest);
      return true;
    case '/history':
    case '/earlier':
      await context.loadEarlierHistory();
      return true;
    case '/model':
      await context.model(rest);
      return true;
    case '/permission':
      await context.permission(rest);
      return true;
    case '/status':
      context.status();
      return true;
    case '/quit':
    case '/exit':
      context.quit();
      return true;
    default:
      return false;
  }
}
