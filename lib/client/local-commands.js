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
    case '/sessions':
      await context.sessions();
      return true;
    case '/reconnect':
      await context.reconnect();
      return true;
    case '/subagents':
    case '/agents':
      await context.agents();
      return true;
    case '/jobs':
      await context.jobs();
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
    case '/images':
      if (rest.trim() === 'clear') context.clearImages();
      else context.images();
      return true;
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
    case '/model':
      await context.model(rest);
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
