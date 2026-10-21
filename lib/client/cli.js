#!/usr/bin/env node
/**
 * `dsh-attach` — attach a terminal UI to the running DeepSeek Harness host.
 *
 * The command only talks to the local bridge socket created by the
 * `dsh-tui-attach` Host plugin. It never starts a second harness and never
 * opens a network listener.
 */
import { AttachClient, AttachError } from './connection.js';
import { formatAge } from './format.js';

const HELP = `dsh-attach — operate a running DeepSeek Harness from the terminal

Usage:
  dsh-attach [options]

Options:
  -s, --session <id>    open this persisted session
      --reattach <id>   attach to this session again (alias for --session)
      --preview <id>    read-only live preview of one Session (no editor)
      --parent <id>     durable parent for a subagent preview
      --preview-exit-after <seconds>
                        exit a preview after this much idle time (0 keeps it open)
      --preview-running treat the preview's initial state as running (used by the Herdr wrapper)
  -n, --new             create a new session and open it
  -p, --prompt <text>   submit this prompt after opening
  -C, --cwd <path>      working directory for a new session
      --list            list sessions and exit (no TUI)
      --all             include subagent sessions in --list
      --endpoint <file> read this endpoint descriptor instead of $DSH_HOME/tui-attach/endpoint.json
      --socket <path>   connect to this Unix socket directly
      --token <token>   token for --socket
      --profile <name>  only consider endpoints written by this profile
      --theme <name>    color theme: light (default) or dark
      --log <file>      lifecycle log (default $DSH_HOME/tui-attach/client.log; off disables)
  -h, --help            show this help
  -V, --version         print the client version

Examples:
  dsh-attach                         pick a session interactively
  dsh-attach --session <id>          attach to a specific session
  dsh-attach --new --prompt "fix the tests"
  dsh-attach --list                  print sessions in the terminal
`;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-V':
      case '--version':
        options.version = true;
        break;
      case '-s':
      case '--session':
      case '--reattach':
        options.session = take();
        break;
      case '--preview':
        options.preview = take();
        break;
      case '--parent':
        options.parent = take();
        break;
      case '--preview-exit-after':
        options.previewExitAfter = take();
        break;
      case '--preview-running':
        options.previewRunning = true;
        break;
      case '-n':
      case '--new':
        options.createNew = true;
        break;
      case '-p':
      case '--prompt':
        options.prompt = take();
        break;
      case '-C':
      case '--cwd':
        options.cwd = take();
        break;
      case '--list':
        options.list = true;
        break;
      case '--all':
        options.all = true;
        break;
      case '--endpoint':
        options.endpoint = take();
        break;
      case '--socket':
        options.socketPath = take();
        break;
      case '--token':
        options.token = take();
        break;
      case '--profile':
        options.profile = take();
        break;
      case '--theme':
        options.theme = take();
        break;
      case '--log':
        options.logPath = take();
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function pad(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
}

async function listSessions(client, showAll) {
  const value = await client.request('session.list');
  const items = (value?.items ?? [])
    .filter((item) => showAll || item.origin !== 'subagent')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (items.length === 0) {
    console.log('No sessions.');
    return;
  }
  console.log(`${pad('ID', 21)} ${pad('AGE', 5)} ${pad('STATE', 8)} ${pad('CWD', 27)} TITLE`);
  for (const item of items) {
    const state = item.running ? 'running' : item.blank ? 'blank' : 'idle';
    console.log(
      `${pad(item.sessionId, 21)} ${pad(formatAge(item.updatedAt), 5)} ${pad(state, 8)} ${pad(item.cwd ?? '', 27)} ${item.title ?? ''}`,
    );
  }
}

/**
 * CLI entry point.
 * @param {string[]} argv
 */
export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`dsh-attach: ${error.message}`);
    console.error(HELP);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.version) {
    console.log('dsh-attach 0.14.0');
    return;
  }
  const theme = options.theme ?? process.env.DSH_ATTACH_THEME ?? 'light';
  if (theme !== 'light' && theme !== 'dark') {
    console.error(`dsh-attach: --theme must be "light" or "dark", got ${JSON.stringify(theme)}`);
    process.exitCode = 2;
    return;
  }
  options.theme = theme;

  if (options.previewExitAfter !== undefined) {
    const seconds = Number(options.previewExitAfter);
    if (!Number.isFinite(seconds) || seconds < 0) {
      console.error('dsh-attach: --preview-exit-after must be a non-negative number of seconds');
      process.exitCode = 2;
      return;
    }
    options.previewExitAfter = seconds;
  }

  const client = new AttachClient();
  try {
    await client.connect({
      endpoint: options.endpoint,
      socketPath: options.socketPath,
      token: options.token,
      profile: options.profile,
    });
  } catch (error) {
    const message = error instanceof AttachError ? error.message : error instanceof Error ? error.message : String(error);
    console.error(`dsh-attach: ${message}`);
    process.exitCode = 1;
    return;
  }

  try {
    if (options.preview !== undefined) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error('dsh-attach: --preview needs a TTY.');
        process.exitCode = 1;
        return;
      }
      const { runPreview } = await import('./preview.js');
      const ok = await runPreview(client, {
        sessionId: options.preview,
        parentSessionId: options.parent,
        theme: options.theme,
        cwd: options.cwd,
        exitAfterSeconds: options.previewExitAfter ?? 0,
        expectRunning: options.previewRunning === true,
      });
      if (!ok) process.exitCode = 1;
      return;
    }
    if (options.list) {
      await listSessions(client, options.all === true);
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error('dsh-attach: the interactive UI needs a TTY. Use --list for non-interactive output.');
      process.exitCode = 1;
      return;
    }
    const { AttachApp } = await import('./app.js');
    const app = new AttachApp(client, options);
    await app.run();
  } catch (error) {
    console.error(`dsh-attach: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    client.close();
  }
}
