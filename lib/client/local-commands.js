/**
 * Local slash-command routing.
 *
 * The handlers live in AttachApp because they need terminal panels, sockets,
 * and session state. This module owns parsing and the dispatch table so the
 * command surface can be tested without constructing a TUI.
 */

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
  usage(context, '/subagent [list|preview [count]|parent|peek]');
}

async function executeSessionGroup(rest, context) {
  const { sub, arg } = splitGroup(rest);
  if (sub === '' || sub === 'list') {
    await context.sessions();
    return;
  }
  if (sub === 'new') {
    await context.newSession(arg);
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
  usage(context, '/session [list|new [cwd]|resume [id]|rename <title>]');
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
    case '/new':
      await context.newSession(rest);
      return true;
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
