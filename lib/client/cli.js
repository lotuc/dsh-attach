#!/usr/bin/env node
/**
 * `dsh-attach` — attach a terminal UI to the running DeepSeek Harness host.
 *
 * The command only talks to the local bridge socket created by the
 * `dsh-attach` Host plugin. It never starts a second harness and never
 * opens a network listener.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AttachClient, AttachError } from './connection.js';
import { connectWithAutostart } from './autostart.js';
import { isPermissionPreset, parseModelSelection, permissionPresetValues } from './exec-options.js';
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
  -f, --prompt-file <path>
                        with --exec, read the prompt from this file
  -o, --output <path>   with --exec, also write the final text to this file
  -C, --cwd <path>      working directory for a new session
      --cache-root <path|@cwd|@session>
                        keep tool caches under this directory (off by default)
      --list            list sessions and exit (no TUI)
      --all             include subagent sessions in --list
      --exec            run one prompt, print the final answer, and exit (no TUI);
                        reads stdin when --prompt and --prompt-file are omitted
      --json            with --exec, print one JSON result object;
                        with --list, print one JSON object of untruncated sessions
      --jsonl           with --exec, stream newline-delimited JSON progress events
      --approvals <deny|host>
                        exec approvals: deny (default) or delegate to DSH Web
      --approval-rules <file|@default>
                        with --exec, load scoped approval rules (TOML/JSONC);
                        @default reads the TUI's auto-approve policy
      --approve         with --exec, allow every approval (dangerous)
      --exec-timeout <seconds>
                        stop a stalled exec; 0 waits forever (default 1800)
      --allow-dir <path>
                        with --exec, register a writable root (repeatable)
      --permission <read-only|workspace-write|danger-full-access|auto>
                        with --exec, apply this permission before the prompt
      --model <provider/model>
                        with --exec, select this provider/model
      --preset <id>     with --exec --new, create the session with this agent preset
      --title <text>    with --exec, rename the session before the prompt
      --endpoint <file> read this endpoint descriptor instead of $DSH_HOME/dsh-attach/endpoint.json
      --socket <path>   connect to this socket or Windows named pipe directly
      --token <token>   token for --socket
      --profile <name>  only consider endpoints written by this profile
      --ssh <target>    attach to a remote DSH over SSH (user@host or an
                        ~/.ssh/config alias); no remote TCP listener is opened
      --remote-bin <path>
                        remote dsh-attach executable (requires --ssh)
      --ssh-opt <arg>   extra argument forwarded to ssh (repeatable; requires --ssh)
      --stdio-proxy     run the remote-side stdin/stdout attach proxy (used by --ssh)
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
  dsh-attach --list --json           print sessions for a dispatcher
  dsh-attach --exec -p "run the tests"
  dsh-attach --exec -s <id> -p "continue"
  dsh-attach --exec -f prompt.md -o answer.md
  dsh-attach --exec --allow-dir ~/shared --permission workspace-write -p "fix it"
  dsh-attach --exec --model provider/model --title "nightly" -p "run the tests"
  printf 'fix the build' | dsh-attach --exec --json
  dsh-attach --exec --jsonl -p "run the tests"
  dsh-attach --exec --approval-rules @default -p "run the tests"
  dsh-attach --ssh user@host         attach over SSH without opening a Host listener
  dsh-attach --ssh host --exec -p "run the tests"   remote one-shot exec
  dsh-attach --ssh host --remote-bin ~/.local/bin/dsh-attach -s <id>
  dsh-attach --hot -s <id>           hot-restart client code while keeping the session

If DeepSeek Harness is not running, dsh-attach starts it and waits for the attach
bridge. Set DSH_ATTACH_NO_START=1 to fail immediately instead.

With --ssh, the local client never starts a Host and never opens a remote TCP
port: ssh runs "dsh-attach --stdio-proxy" on the remote side, which discovers
that host's endpoint.json and injects its token. Under --ssh, --cwd, --allow-dir,
--endpoint and --cache-root are remote paths and are not expanded locally;
--cache-root @cwd is rejected (use @session or an explicit remote path).
`;

/**
 * Parse CLI arguments without validating their combinations.
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
export function parseArgs(argv) {
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
      case '--jsonl':
        options.jsonl = true;
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
      case '--allow-dir':
        (options.allowDirs ??= []).push(take());
        break;
      case '--permission':
        options.permission = take();
        break;
      case '--model':
        options.model = take();
        break;
      case '--preset':
        options.preset = take();
        break;
      case '--title':
        options.title = take();
        break;
      case '-p':
      case '--prompt':
        options.prompt = take();
        break;
      case '-f':
      case '--prompt-file':
        options.promptFile = take();
        break;
      case '-o':
      case '--output':
        options.output = take();
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
      case '--ssh':
        options.ssh = take();
        break;
      case '--remote-bin':
        options.remoteBin = take();
        break;
      case '--ssh-opt':
        (options.sshOpts ??= []).push(take());
        break;
      case '--stdio-proxy':
        options.stdioProxy = true;
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
  if (options.promptFile !== undefined) {
    let text;
    try {
      text = await readFile(options.promptFile, 'utf8');
    } catch (error) {
      throw new AttachError(
        `cannot read prompt file ${options.promptFile}: ${error instanceof Error ? error.message : String(error)}`,
        'attach/exec-input',
      );
    }
    if (text.trim() === '') throw new AttachError(`prompt file ${options.promptFile} is empty`, 'attach/exec-input');
    return text;
  }
  if (options.prompt !== undefined) {
    if (options.prompt.trim() === '') throw new AttachError('--exec needs a non-empty prompt', 'attach/exec-input');
    return options.prompt;
  }
  if (process.stdin.isTTY) {
    throw new AttachError('--exec needs --prompt, --prompt-file, or a prompt on stdin', 'attach/exec-input');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString('utf8');
  if (text.trim() === '') throw new AttachError('--exec received an empty prompt on stdin', 'attach/exec-input');
  return text;
}

/**
 * Expand paths and validate flag combinations. Throws on any usage error; the
 * caller maps that to exit code 2.
 *
 * @param {Record<string, any>} options
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, any>}
 */
export function normalizeOptions(options, env = process.env) {
  if (options.ssh !== undefined) {
    if (typeof options.ssh !== 'string' || options.ssh.trim() === '') {
      throw new Error('--ssh needs a target (user@host or an ssh alias)');
    }
    options.ssh = options.ssh.trim();
  }
  const remote = typeof options.ssh === 'string';
  if (options.remoteBin !== undefined) {
    if (!remote) throw new Error('--remote-bin requires --ssh');
    if (typeof options.remoteBin !== 'string' || options.remoteBin.trim() === '') {
      throw new Error('--remote-bin needs a non-empty path');
    }
    options.remoteBin = options.remoteBin.trim();
  }
  if (options.sshOpts !== undefined) {
    if (!remote) throw new Error('--ssh-opt requires --ssh');
    if (!Array.isArray(options.sshOpts)) throw new Error('--ssh-opt must be repeatable arguments');
    if (options.sshOpts.some((value) => typeof value !== 'string' || value.trim() === '')) {
      throw new Error('--ssh-opt needs a non-empty argument');
    }
  }
  if (remote && options.socketPath !== undefined) {
    throw new Error('--ssh cannot be combined with --socket');
  }
  if (remote && options.hot === true) {
    throw new Error('--ssh cannot be combined with --hot');
  }
  if (options.stdioProxy === true) {
    if (options.exec === true) throw new Error('--stdio-proxy cannot be combined with --exec');
    if (options.list === true) throw new Error('--stdio-proxy cannot be combined with --list');
    if (options.preview !== undefined) throw new Error('--stdio-proxy cannot be combined with --preview');
    if (options.hot === true) throw new Error('--stdio-proxy cannot be combined with --hot');
    if (remote) throw new Error('--stdio-proxy cannot be combined with --ssh');
    if (options.socketPath !== undefined && options.token === undefined) {
      throw new Error('--stdio-proxy with --socket needs --token');
    }
  }

  // `--cwd`, `--allow-dir`, `--endpoint` and `--cache-root` name paths on the
  // remote host in SSH mode; expanding them with the local home/process cwd
  // would silently target the wrong machine.
  const pathKeys = remote
    ? ['logPath', 'approvalRules', 'promptFile', 'output']
    : ['endpoint', 'logPath', 'cwd', 'cacheRoot', 'approvalRules', 'promptFile', 'output'];
  for (const key of pathKeys) {
    if (typeof options[key] === 'string') options[key] = expandHomePath(options[key]);
  }
  if (Array.isArray(options.allowDirs)) {
    options.allowDirs = options.allowDirs.map((directory) => (
      typeof directory === 'string'
        ? (remote ? directory.trim() : expandHomePath(directory).trim())
        : ''
    ));
  }
  if (options.cacheRoot !== undefined) {
    if (remote) {
      const text = String(options.cacheRoot).trim();
      if (text === '@cwd') {
        throw new Error(
          '--cache-root @cwd is unavailable with --ssh because the working directory is remote; ' +
            'use --cache-root @session or an explicit remote path',
        );
      }
      options.cacheRoot = text === '' ? null : text;
    } else {
      options.cacheRoot = resolveCacheRootOption(options.cacheRoot, process.cwd());
    }
  }
  const theme = options.theme ?? env.DSH_ATTACH_THEME ?? 'light';
  if (theme !== 'light' && theme !== 'dark') {
    throw new Error(`--theme must be "light" or "dark", got ${JSON.stringify(theme)}`);
  }
  options.theme = theme;

  if (options.json === true && options.exec !== true && options.list !== true) {
    throw new Error('--json requires --exec or --list');
  }
  if (options.jsonl === true && options.json === true) {
    throw new Error('--jsonl cannot be combined with --json');
  }
  if (options.jsonl === true && options.exec !== true) {
    throw new Error('--jsonl requires --exec');
  }
  const execOnly = [
    [options.execTimeout !== undefined, '--exec-timeout'],
    [options.approve === true, '--approve'],
    [options.approvals !== undefined, '--approvals'],
    [options.approvalRules !== undefined, '--approval-rules'],
    [options.allowDirs !== undefined, '--allow-dir'],
    [options.permission !== undefined, '--permission'],
    [options.model !== undefined, '--model'],
    [options.preset !== undefined, '--preset'],
    [options.title !== undefined, '--title'],
    [options.promptFile !== undefined, '--prompt-file'],
    [options.output !== undefined, '--output'],
  ];
  for (const [present, flag] of execOnly) {
    if (present && options.exec !== true) throw new Error(`${flag} requires --exec`);
  }
  if (options.approvals !== undefined && !['deny', 'host'].includes(options.approvals)) {
    throw new Error('--approvals must be "deny" or "host"');
  }
  if (options.approvals === 'host' && options.approve === true) {
    throw new Error('--approvals=host cannot be combined with --approve');
  }
  if (options.permission !== undefined && !isPermissionPreset(options.permission)) {
    throw new Error(`--permission must be one of ${permissionPresetValues().join(', ')}`);
  }
  if (options.model !== undefined && parseModelSelection(options.model) === null) {
    throw new Error('--model must use the provider/model form');
  }
  if (options.title !== undefined && (typeof options.title !== 'string' || options.title.trim() === '')) {
    throw new Error('--title needs a non-empty title');
  }
  if (options.preset !== undefined && (typeof options.preset !== 'string' || options.preset.trim() === '')) {
    throw new Error('--preset needs a non-empty agent preset id');
  }
  if (Array.isArray(options.allowDirs) && options.allowDirs.some((directory) => directory === '')) {
    throw new Error('--allow-dir needs a non-empty path');
  }
  if (options.promptFile !== undefined && typeof options.promptFile === 'string' && options.promptFile.trim() === '') {
    throw new Error('--prompt-file needs a file path');
  }
  if (options.output !== undefined && (typeof options.output !== 'string' || options.output.trim() === '')) {
    throw new Error('--output needs a file path');
  }
  if (options.session !== undefined && (typeof options.session !== 'string' || options.session.trim() === '')) {
    throw new Error('--session needs a session id');
  }
  if (options.exec === true) {
    if (options.list === true || options.preview !== undefined || options.parent !== undefined
      || options.previewExitAfter !== undefined || options.previewRunning === true) {
      throw new Error('--exec cannot be combined with --list or preview options');
    }
    if (options.createNew === true && options.session !== undefined) {
      throw new Error('--exec needs either --new or --session, not both');
    }
    if (options.cwd !== undefined && options.session !== undefined) {
      throw new Error('--cwd only applies to a new session');
    }
    if (options.preset !== undefined && options.session !== undefined) {
      throw new Error('--preset only applies to a new session');
    }
    if (options.prompt !== undefined && options.promptFile !== undefined) {
      throw new Error('--prompt and --prompt-file cannot be combined');
    }
  }
  if (options.execTimeout !== undefined) {
    const seconds = Number(options.execTimeout);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error('--exec-timeout must be a non-negative number of seconds');
    }
    options.execTimeout = seconds * 1000;
  }
  return options;
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

/**
 * Build the machine-readable `--list --json` payload.
 *
 * The table view truncates columns; a dispatcher needs the exact ids, cwds, and
 * preset/model names, so this projection never shortens a value.
 *
 * @param {{items?: unknown[]}|null|undefined} value - a `session.list` result
 * @param {boolean} showAll
 * @returns {{items: Array<Record<string, unknown>>}}
 */
export function sessionListPayload(value, showAll) {
  const items = (Array.isArray(value?.items) ? value.items : [])
    .filter((item) => showAll || item?.origin !== 'subagent')
    .sort((a, b) => Number(b?.updatedAt ?? 0) - Number(a?.updatedAt ?? 0))
    .map((item) => ({
      sessionId: String(item?.sessionId ?? ''),
      title: item?.title ?? null,
      cwd: item?.cwd ?? null,
      updatedAt: Number(item?.updatedAt ?? 0),
      running: item?.running === true,
      blank: item?.blank === true,
      parentSessionId: item?.parentSessionId ?? null,
      origin: item?.origin ?? null,
      agentPreset: item?.agentPreset ?? null,
      model: item?.model ?? null,
    }));
  return { items };
}

/**
 * Print the session table, or one JSON payload with `--list --json`.
 * @param {AttachClient} client
 * @param {boolean} showAll
 * @param {{json?: boolean, out?: (line: string) => void}} [options]
 */
export async function listSessions(client, showAll, { json = false, out = console.log } = {}) {
  const payload = sessionListPayload(await client.request('session.list'), showAll);
  if (json) {
    out(JSON.stringify(payload));
    return;
  }
  if (payload.items.length === 0) {
    out('No sessions.');
    return;
  }
  out(`${pad('ID', 21)} ${pad('AGE', 5)} ${pad('STATE', 8)} ${pad('CWD', 27)} TITLE`);
  for (const item of payload.items) {
    const state = item.running ? 'running' : item.blank ? 'blank' : 'idle';
    out(
      `${pad(item.sessionId, 21)} ${pad(formatAge(item.updatedAt), 5)} ${pad(state, 8)} ${pad(item.cwd ?? '', 27)} ${item.title ?? ''}`,
    );
  }
}

function failureOfResult(result) {
  if (result.failure !== null && result.failure !== undefined) return failureText(result.failure);
  if (result.ok === true) return null;
  const reason = typeof result.reason === 'string' ? result.reason : '';
  return `turn ended${reason === '' ? '' : `: ${reason}`}`;
}

/**
 * Run one `--exec` request and print its result in the selected format.
 *
 * Returns the process exit code instead of setting `process.exitCode` so the
 * behavior is testable. `runner` defaults to the real `runExec`; tests inject a
 * stub to exercise output and error paths without a Host.
 *
 * @param {AttachClient} client
 * @param {Record<string, any>} options - normalized CLI options
 * @param {{prompt: string, rules?: object|null, runner?: Function,
 *   stdout?: {write: (text: string) => unknown}, stderr?: {write: (text: string) => unknown}}} control
 * @returns {Promise<number>}
 */
export async function runExecCommand(client, options, {
  prompt,
  rules = null,
  runner,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const emit = (value) => stdout.write(`${JSON.stringify(value)}\n`);
  const writeError = (sessionId, error) => {
    const code = typeof error?.code === 'string' ? error.code : 'attach/error';
    const message = error instanceof Error ? error.message : String(error);
    if (options.jsonl === true) {
      emit({ type: 'error', ok: false, sessionId, error: { code, message } });
    } else if (options.json === true) {
      stdout.write(`${JSON.stringify({ ok: false, sessionId, error: { code, message } })}\n`);
    } else {
      stderr.write(`dsh-attach: ${message}\n`);
      if (sessionId !== null && !sessionAnnounced) stderr.write(`dsh-attach: session ${sessionId}\n`);
    }
  };

  let sessionAnnounced = false;
  let result;
  try {
    const run = runner ?? (await import('./exec.js')).runExec;
    result = await run(client, {
      sessionId: options.session,
      prompt,
      cwd: options.cwd,
      cacheRoot: options.cacheRoot,
      timeoutMs: options.execTimeout,
      approvals: options.approvals ?? 'deny',
      approvalRules: rules,
      approve: options.approve === true,
      allowDirs: options.allowDirs ?? [],
      permission: options.permission,
      model: options.model,
      preset: options.preset,
      title: options.title,
      ...(typeof options.ssh === 'string' ? {
        ssh: options.ssh,
        sshOpts: options.sshOpts ?? [],
        remoteBin: options.remoteBin,
        profile: options.profile,
        reconnect: () => client.reconnect({
          ssh: options.ssh,
          sshOpts: options.sshOpts ?? [],
          remoteBin: options.remoteBin,
          endpoint: options.endpoint,
          profile: options.profile,
          batchMode: true,
          timeoutMs: 15_000,
        }),
      } : {}),
      warn: (message) => stderr.write(`dsh-attach: ${message}\n`),
      onSession: (sessionId, facts) => {
        sessionAnnounced = true;
        if (options.jsonl === true) {
          emit({ type: 'session.started', sessionId, cwd: facts?.cwd ?? null });
        } else {
          stderr.write(`dsh-attach: session ${sessionId}\n`);
        }
      },
      ...(options.jsonl === true ? {
        onToolCall: (call) => emit({
          type: 'tool.call',
          sessionId: call.sessionId,
          callId: call.callId,
          name: call.name,
        }),
        onInteraction: (record) => emit({
          type: 'interaction',
          sessionId: record.sessionId,
          kind: record.type,
          requestId: record.requestId ?? null,
          tool: record.tool ?? null,
          callId: record.callId ?? null,
          reason: record.reason ?? null,
          outcome: record.outcome ?? null,
          decision: record.decision ?? null,
        }),
      } : {}),
    });
  } catch (error) {
    const sessionId = typeof error?.sessionId === 'string' ? error.sessionId : null;
    writeError(sessionId, error);
    return execExitCode(error);
  }
  result ??= {};

  if (options.output !== undefined && typeof result?.text === 'string' && result.text !== '') {
    try {
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, result.text, 'utf8');
    } catch (error) {
      writeError(typeof result?.sessionId === 'string' ? result.sessionId : null, Object.assign(
        new Error(`cannot write ${options.output}: ${error instanceof Error ? error.message : String(error)}`),
        { code: 'attach/exec-output' },
      ));
      return 1;
    }
  }

  const failure = failureOfResult(result ?? {});
  if (options.jsonl === true) {
    emit({
      type: 'turn.end',
      ok: result.ok === true,
      sessionId: result.sessionId ?? null,
      turn: result.turn ?? 0,
      text: result.text ?? '',
      reason: result.reason ?? '',
      failure: result.failure ?? null,
      usage: result.usage ?? null,
      interactions: result.interactions ?? [],
      error: failure,
    });
  } else if (options.json === true) {
    stdout.write(`${JSON.stringify({ ...result, sessionId: result.sessionId ?? null, error: failure, ok: result.ok === true })}\n`);
  } else if (typeof result.text === 'string' && result.text !== '') {
    stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
  }
  if (result.ok !== true) {
    stderr.write(`dsh-attach: ${failure}\n`);
    if (typeof result.sessionId === 'string' && result.sessionId !== '' && !sessionAnnounced) {
      stderr.write(`dsh-attach: session ${result.sessionId}\n`);
    }
    return 1;
  }
  return 0;
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
  try {
    options = normalizeOptions(options);
  } catch (error) {
    console.error(`dsh-attach: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  if (options.stdioProxy === true) {
    const { runStdioProxy } = await import('./stdio-proxy.js');
    process.exitCode = await runStdioProxy({
      endpoint: options.endpoint,
      socketPath: options.socketPath,
      token: options.token,
      profile: options.profile,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      // The local client owns auto-start; a remote proxy expects a running Host.
      autoStart: false,
    });
    return;
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
      if (options.jsonl === true) {
        process.stdout.write(`${JSON.stringify({ type: 'error', ok: false, sessionId: null, error: { code, message } })}\n`);
      } else if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ ok: false, sessionId: null, error: { code, message } })}\n`);
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
  if (hot && typeof options.ssh === 'string') {
    console.error('dsh-attach: --ssh cannot be combined with --hot');
    process.exitCode = 2;
    return;
  }
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

  const remote = typeof options.ssh === 'string';
  const connectOptions = {
    endpoint: options.endpoint,
    socketPath: options.socketPath,
    token: options.token,
    profile: options.profile,
    ...(remote ? {
      ssh: options.ssh,
      sshOpts: options.sshOpts ?? [],
      remoteBin: options.remoteBin,
      // Scripted modes must never block on an interactive SSH prompt.
      batchMode: options.exec === true || options.list === true,
      timeoutMs: 15_000,
    } : {}),
  };
  const client = new AttachClient();
  try {
    if (remote) {
      // SSH mode must never start a local Host: the remote side owns discovery.
      await client.connect(connectOptions);
    } else {
      await connectWithAutostart(client, connectOptions, {
        autoStart: process.env.DSH_ATTACH_NO_START !== '1',
        onLaunch: (launch) => {
          console.error(`dsh-attach: starting ${launch.label}...`);
        },
        onWait: (timeoutMs) => {
          console.error(`dsh-attach: waiting up to ${Math.round(timeoutMs / 1000)}s for the attach bridge...`);
        },
      });
    }
  } catch (error) {
    const message = error instanceof AttachError ? error.message : error instanceof Error ? error.message : String(error);
    const code = typeof error?.code === 'string' ? error.code : 'attach/error';
    if (options.exec === true && options.jsonl === true) {
      process.stdout.write(`${JSON.stringify({ type: 'error', ok: false, sessionId: null, error: { code, message } })}\n`);
    } else if (options.exec === true && options.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: false, sessionId: null, error: { code, message } })}\n`);
    } else {
      console.error(`dsh-attach: ${message}`);
    }
    process.exitCode = options.exec === true ? execExitCode(error) : 1;
    return;
  }

  try {
    if (options.exec === true) {
      const code = await runExecCommand(client, options, { prompt: execPrompt, rules: execRules });
      if (code !== 0) process.exitCode = code;
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
      await listSessions(client, options.all === true, { json: options.json === true });
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
    const code = typeof error?.code === 'string' ? error.code : 'attach/error';
    const sessionId = typeof error?.sessionId === 'string' ? error.sessionId : null;
    if (options.exec === true && options.jsonl === true) {
      process.stdout.write(`${JSON.stringify({ type: 'error', ok: false, sessionId, error: { code, message } })}\n`);
    } else if (options.exec === true && options.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: false, sessionId, error: { code, message } })}\n`);
    } else {
      console.error(`dsh-attach: ${message}`);
    }
    process.exitCode = options.exec === true ? execExitCode(error) : 1;
  } finally {
    client.close();
  }
}
