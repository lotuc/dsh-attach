#!/usr/bin/env node
/**
 * `dsh-attach` — attach a terminal UI to the running DeepSeek Harness host.
 *
 * The command only talks to the local bridge socket created by the
 * `dsh-attach` Host plugin. It never starts a second harness and never
 * opens a network listener.
 */
import { fileURLToPath } from 'node:url';

import { AttachClient, AttachError } from './connection.js';
import { connectWithAutostart } from './autostart.js';
import { formatAge } from './format.js';
import { failureText } from './turn-failure.js';
import { loadExecApprovalRules } from './exec-rules.js';
import { VERSION } from '../shared/version.js';
import { expandHomePath } from '../shared/platform.js';
import { resolveCacheRootOption } from '../shared/cache-root.js';

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
      --cache-root <path|@cwd|@session>
                        keep tool caches under this directory (off by default)
      --list            list sessions and exit (no TUI)
      --all             include subagent sessions in --list
      --exec            run one prompt, print the final answer, and exit (no TUI);
                        reads stdin when --prompt is omitted
      --json            with --exec, print one JSON result object
      --approvals <deny|host>
                        exec approvals: deny (default) or delegate to DSH Web
      --approval-rules <file>
                        with --exec, load scoped approval rules (TOML/JSONC)
      --approve         with --exec, allow every approval (dangerous)
      --exec-timeout <seconds>
                        stop a stalled exec; 0 waits forever (default 1800)
      --endpoint <file> read this endpoint descriptor instead of $DSH_HOME/dsh-attach/endpoint.json
      --socket <path>   connect to this socket or Windows named pipe directly
      --token <token>   token for --socket
      --profile <name>  only consider endpoints written by this profile
      --theme <name>    color theme: light (default) or dark
      --log <file>      lifecycle log (default $DSH_HOME/dsh-attach/client.log; off disables)
      --hot             dev mode: restart the TUI when client sources change
  -h, --help            show this help
  -V, --version         print the client version

Examples:
  dsh-attach                         pick a session interactively
  dsh-attach --session <id>          attach to a specific session
  dsh-attach --new --prompt "fix the tests"
  dsh-attach --cache-root @session -s <id>
  dsh-attach --list                  print sessions in the terminal
  dsh-attach --exec -p "run the tests"
  dsh-attach --exec -s <id> -p "continue"
  printf 'fix the build' | dsh-attach --exec --json
  dsh-attach --exec --approval-rules ./approval.toml -p "run the tests"
  dsh-attach --hot -s <id>           hot-restart client code while keeping the session

If DeepSeek Harness is not running, dsh-attach starts it and waits for the attach
bridge. Set DSH_ATTACH_NO_START=1 to fail immediately instead.
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
      case '--exec':
        options.exec = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--approve':
        options.approve = true;
        break;
      case '--approvals':
        options.approvals = take();
        break;
      case '--approval-rules':
        options.approvalRules = take();
        break;
      case '--exec-timeout':
        options.execTimeout = take();
        break;
      case '-p':
      case '--prompt':
        options.prompt = take();
        break;
      case '-C':
      case '--cwd':
        options.cwd = take();
        break;
      case '--cache-root':
        options.cacheRoot = take();
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
      case '--hot':
        options.hot = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

async function readExecPrompt(options) {
  if (options.prompt !== undefined) {
    if (options.prompt.trim() === '') throw new Error('--exec needs a non-empty prompt');
    return options.prompt;
  }
  if (process.stdin.isTTY) {
    throw new Error('--exec needs --prompt or a prompt on stdin');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString('utf8');
  if (text.trim() === '') throw new Error('--exec received an empty prompt on stdin');
  return text;
}

function execExitCode(error) {
  if (error?.code === 'attach/exec-timeout') return 124;
  if (error?.code === 'attach/exec-interrupted') return 130;
  return 1;
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
    console.log(`dsh-attach ${VERSION}`);
    return;
  }
  for (const key of ['endpoint', 'logPath', 'cwd', 'cacheRoot', 'approvalRules']) {
    if (typeof options[key] === 'string') options[key] = expandHomePath(options[key]);
  }
  if (options.cacheRoot !== undefined) {
    try {
      options.cacheRoot = resolveCacheRootOption(options.cacheRoot, process.cwd());
    } catch (error) {
      console.error(`dsh-attach: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
      return;
    }
  }
  const theme = options.theme ?? process.env.DSH_ATTACH_THEME ?? 'light';
  if (theme !== 'light' && theme !== 'dark') {
    console.error(`dsh-attach: --theme must be "light" or "dark", got ${JSON.stringify(theme)}`);
    process.exitCode = 2;
    return;
  }
  options.theme = theme;

  if (options.json === true && options.exec !== true) {
    console.error('dsh-attach: --json requires --exec');
    process.exitCode = 2;
    return;
  }
  if (options.execTimeout !== undefined && options.exec !== true) {
    console.error('dsh-attach: --exec-timeout requires --exec');
    process.exitCode = 2;
    return;
  }
  if (options.approve === true && options.exec !== true) {
    console.error('dsh-attach: --approve requires --exec');
    process.exitCode = 2;
    return;
  }
  if (options.approvals !== undefined && options.exec !== true) {
    console.error('dsh-attach: --approvals requires --exec');
    process.exitCode = 2;
    return;
  }
  if (options.approvalRules !== undefined && options.exec !== true) {
    console.error('dsh-attach: --approval-rules requires --exec');
    process.exitCode = 2;
    return;
  }
  if (options.approvals !== undefined && !['deny', 'host'].includes(options.approvals)) {
    console.error('dsh-attach: --approvals must be "deny" or "host"');
    process.exitCode = 2;
    return;
  }
  if (options.approvals === 'host' && options.approve === true) {
    console.error('dsh-attach: --approvals=host cannot be combined with --approve');
    process.exitCode = 2;
    return;
  }
  if (options.exec === true) {
    if (options.list === true || options.preview !== undefined || options.parent !== undefined
      || options.previewExitAfter !== undefined || options.previewRunning === true) {
      console.error('dsh-attach: --exec cannot be combined with --list or preview options');
      process.exitCode = 2;
      return;
    }
    if (options.createNew === true && options.session !== undefined) {
      console.error('dsh-attach: --exec needs either --new or --session, not both');
      process.exitCode = 2;
      return;
    }
    if (options.cwd !== undefined && options.session !== undefined) {
      console.error('dsh-attach: --cwd only applies to a new session');
      process.exitCode = 2;
      return;
    }
  }
  if (options.execTimeout !== undefined) {
    const seconds = Number(options.execTimeout);
    if (!Number.isFinite(seconds) || seconds < 0) {
      console.error('dsh-attach: --exec-timeout must be a non-negative number of seconds');
      process.exitCode = 2;
      return;
    }
    options.execTimeout = seconds * 1000;
  }

  let execPrompt;
  let execRules = null;
  if (options.exec === true) {
    try {
      execPrompt = await readExecPrompt(options);
      if (options.approvalRules !== undefined) {
        execRules = await loadExecApprovalRules(options.approvalRules);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error?.code === 'string' ? error.code : 'attach/exec-input';
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
      } else {
        console.error(`dsh-attach: ${message}`);
      }
      process.exitCode = 2;
      return;
    }
  }

  if (options.exec === true && (options.hot === true || process.env.DSH_ATTACH_HOT === '1')) {
    console.error('dsh-attach: --exec cannot be combined with --hot');
    process.exitCode = 2;
    return;
  }

  const hot = options.exec !== true && (options.hot === true || process.env.DSH_ATTACH_HOT === '1');
  if (hot && options.list !== true) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error('dsh-attach: --hot needs a TTY.');
      process.exitCode = 1;
      return;
    }
    const { runHotReload } = await import('./hot-reload.js');
    await runHotReload({
      root: fileURLToPath(new URL('../../', import.meta.url)),
      argv: argv.filter((arg) => arg !== '--hot'),
    });
    return;
  }

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
    await connectWithAutostart(client, {
      endpoint: options.endpoint,
      socketPath: options.socketPath,
      token: options.token,
      profile: options.profile,
    }, {
      autoStart: process.env.DSH_ATTACH_NO_START !== '1',
      onLaunch: (launch) => {
        console.error(`dsh-attach: starting ${launch.label}...`);
      },
      onWait: (timeoutMs) => {
        console.error(`dsh-attach: waiting up to ${Math.round(timeoutMs / 1000)}s for the attach bridge...`);
      },
    });
  } catch (error) {
    const message = error instanceof AttachError ? error.message : error instanceof Error ? error.message : String(error);
    if (options.exec === true && options.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error?.code ?? 'attach/error', message } })}\n`);
    } else {
      console.error(`dsh-attach: ${message}`);
    }
    process.exitCode = options.exec === true ? execExitCode(error) : 1;
    return;
  }

  try {
    if (options.exec === true) {
      const { runExec } = await import('./exec.js');
      const result = await runExec(client, {
        sessionId: options.session,
        prompt: execPrompt,
        cwd: options.cwd,
        cacheRoot: options.cacheRoot,
        timeoutMs: options.execTimeout,
        approvals: options.approvals ?? 'deny',
        approvalRules: execRules,
        approve: options.approve === true,
        warn: (message) => console.error(`dsh-attach: ${message}`),
      });
      const failure = result.failure === null || result.failure === undefined
        ? (result.ok ? null : `turn ended${result.reason === '' ? '' : `: ${result.reason}`}`)
        : failureText(result.failure);
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ ...result, error: failure, ok: result.ok === true })}\n`);
      } else if (result.text !== '') {
        process.stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
      }
      if (result.ok !== true) {
        console.error(`dsh-attach: ${failure}`);
        process.exitCode = 1;
      }
      return;
    }
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
        cacheRoot: options.cacheRoot,
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
    const message = error instanceof Error ? error.message : String(error);
    if (options.exec === true && options.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error?.code ?? 'attach/error', message } })}\n`);
    } else {
      console.error(`dsh-attach: ${message}`);
    }
    process.exitCode = options.exec === true ? execExitCode(error) : 1;
  } finally {
    client.close();
  }
}
