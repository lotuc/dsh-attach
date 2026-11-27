/**
 * Claude Code CLI compatibility adapter for DeepSeek Harness.
 *
 * Claude-compatible orchestrators (Multica, wrappers, scripts) already know
 * how to drive a `claude` process: they pass `--print`, `--output-format
 * stream-json`, `--input-format stream-json`, and read Claude Code's NDJSON
 * frames from stdout. This module maps that thin surface onto `runExec` and
 * `AttachClient`, so the same orchestrator can drive a live local or remote
 * DSH Session without a fork of its Claude provider.
 *
 * The adapter deliberately keeps no state of its own beyond one Session id:
 * `runExec` owns turn lifecycle, approvals, reconnects, and timeouts.
 */
import { delimiter } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { AttachClient, AttachError } from './connection.js';
import { connectWithAutostart } from './autostart.js';
import { runExec } from './exec.js';
import { isPermissionPreset, parseModelSelection } from './exec-options.js';
import { loadExecApprovalRules } from './exec-rules.js';
import { ClientLog, resolveLogPath } from './log.js';
import {
  loadRemotesSync,
  mergeRemoteOptions,
  resolveRemoteAlias,
  resolveRemotesPath,
} from './remotes.js';
import { failureText } from './turn-failure.js';
import { VERSION } from '../shared/version.js';
import { expandHomePath } from '../shared/platform.js';
import { resolveCacheRootOption } from '../shared/cache-root.js';

/** Claude Code version this adapter advertises to orchestrator health checks. */
export const CLAUDE_COMPAT_VERSION = '2.1.0';
/** Tools advertised in the stream-json `system/init` frame. */
export const CLAUDE_TOOLS = Object.freeze(['bash', 'read', 'write', 'edit']);
/** Deltas are coalesced so a token stream becomes readable NDJSON frames. */
export const STREAM_FLUSH_INTERVAL_MS = 250;

const OUTPUT_FORMATS = new Set(['text', 'json', 'stream-json']);
const INPUT_FORMATS = new Set(['text', 'stream-json']);
const APPROVAL_MODES = new Set(['deny', 'host']);

/**
 * Flags that take a value but have no meaning for DSH. They are consumed so a
 * following prompt or path is not mistaken for a positional prompt.
 */
const IGNORED_VALUE_FLAGS = new Set([
  '--mcp-config',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--tools',
  '--max-turns',
  '--effort',
  '--fallback-model',
  '--setting-sources',
  '--settings',
  '--session-id',
  '--debug-file',
  '--permission-prompt-tool',
  '--agents',
  '--json-schema',
  '--max-budget-usd',
  '--plugin-dir',
]);

/** Boolean Claude flags that are accepted and intentionally ignored. */
const IGNORED_BOOLEAN_FLAGS = new Set([
  '--strict-mcp-config',
  '--debug',
  '--fork-session',
  '--disable-slash-commands',
]);

export const CLAUDE_HELP = `dsh-attach-claude — drive DeepSeek Harness through Claude Code's CLI protocol

Usage:
  dsh-attach-claude -p "prompt" [--output-format text|json|stream-json]
  printf 'prompt' | dsh-attach-claude -p
  printf '{"type":"user","message":{"role":"user","content":"prompt"}}\\n' \\
    | dsh-attach-claude --input-format stream-json --output-format stream-json

Claude-compatible options:
  -p, --print                      headless mode (optional inline prompt)
      --output-format <format>     text (default), json, or stream-json
      --input-format <format>      text (default) or stream-json
  -r, --resume <session-id>        continue an idle DSH Session
      --model <name>               a provider/model is forwarded; Claude aliases
                                   fall back to DSH's configured default
      --permission-mode <mode>     plan, acceptEdits, default, bypassPermissions
      --system-prompt <text>       prepended to the first prompt
      --append-system-prompt <text>
      --add-dir <path>             register an extra writable root (repeatable)
      --dangerously-skip-permissions
                                   accepted; never escalates DSH permissions
  -v, --version                    print the compatibility version
  -h, --help                       print this help

Environment:
  DSH_ATTACH_REMOTE                remote alias from $DSH_HOME/dsh-attach/remotes.toml
  DSH_ATTACH_SSH                   raw SSH target
  DSH_ATTACH_PROFILE               DSH profile (local) or remote Host profile
  DSH_ATTACH_MODEL                 provider/model override
  DSH_ATTACH_PERMISSION            read-only|workspace-write|danger-full-access|auto
  DSH_ATTACH_CACHE_ROOT            cache root (default @session)
  DSH_ATTACH_APPROVALS             deny (default) or host
  DSH_ATTACH_APPROVAL_RULES        <file|@default>
  DSH_ATTACH_ALLOW_DIRS            extra writable roots, separated by the
                                   platform path delimiter
  DSH_ATTACH_TIMEOUT               per-turn timeout in seconds (default 0, no limit)
  DSH_ATTACH_WAIT_SUBAGENTS        wait for running subagents before exiting (default 1; 0 disables)

Diagnostics always go to stderr; stdout carries only protocol frames.
`;

function messageOf(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function usageError(message) {
  return Object.assign(new Error(message), { code: 'attach/claude-usage' });
}

function envText(env, name) {
  const value = env?.[name];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** Whether `value` looks like another option rather than a prompt. */
function looksLikeOption(value) {
  return typeof value === 'string' && value.length > 1 && value.startsWith('-');
}

/**
 * Map Claude Code permission modes onto DSH presets.
 *
 * `bypassPermissions` deliberately maps to `workspace-write`, not
 * `danger-full-access`: an orchestrator flag must never silently remove the
 * sandbox. Only an explicit `DSH_ATTACH_PERMISSION=danger-full-access` does.
 *
 * @param {unknown} mode
 * @returns {'read-only'|'workspace-write'|'danger-full-access'|'auto'|undefined}
 */
export function mapClaudePermissionMode(mode) {
  switch (mode) {
    case 'plan':
      return 'read-only';
    case 'default':
    case 'acceptEdits':
    case 'bypassPermissions':
      return 'workspace-write';
    case 'read-only':
    case 'workspace-write':
    case 'danger-full-access':
    case 'auto':
      return mode;
    default:
      return undefined;
  }
}

/** Path-delimiter separated allow-dir list from `DSH_ATTACH_ALLOW_DIRS`. */
export function splitAllowDirs(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.split(delimiter).map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/**
 * Parse Claude Code CLI arguments into adapter options.
 *
 * Unknown flags are recorded and ignored so a newer orchestrator flag cannot
 * break execution. Value flags that only affect Claude are consumed without
 * being forwarded. Environment overrides are applied last so a wrapper can
 * target a remote Host without adding custom flags.
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, any>}
 */
export function parseClaudeArgs(argv = [], env = process.env) {
  const options = {
    version: false,
    help: false,
    print: false,
    outputFormat: 'text',
    inputFormat: 'text',
    allowDirs: [],
    sshOpts: [],
    verbose: false,
    replayUserMessages: false,
    includePartialMessages: false,
    dangerouslySkipPermissions: false,
    ignoredFlags: [],
  };
  const positionals = [];
  let prompt;

  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index];
    let inlineValue;
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      if (equals > 2) {
        inlineValue = arg.slice(equals + 1);
        arg = arg.slice(0, equals);
      }
    } else if (arg.startsWith('-p=') || arg.startsWith('-r=')) {
      inlineValue = arg.slice(3);
      arg = arg.slice(0, 2);
    }
    const take = (flag) => {
      if (inlineValue !== undefined) return inlineValue;
      const value = argv[index + 1];
      if (value === undefined) {
        options.ignoredFlags.push(`${flag}(missing value)`);
        return undefined;
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '-v':
      case '--version':
        options.version = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-p':
      case '--print':
        options.print = true;
        if (inlineValue !== undefined) {
          prompt = inlineValue;
        } else {
          const next = argv[index + 1];
          if (next !== undefined && !looksLikeOption(next)) {
            prompt = next;
            index += 1;
          }
        }
        break;
      case '--output-format':
        options.outputFormat = take('--output-format') ?? options.outputFormat;
        break;
      case '--input-format':
        options.inputFormat = take('--input-format') ?? options.inputFormat;
        break;
      case '-r':
      case '--resume':
        options.resume = take('--resume');
        break;
      case '--model':
        options.rawModel = take('--model');
        break;
      case '--permission-mode':
        options.rawPermissionMode = take('--permission-mode');
        break;
      case '--system-prompt':
        options.systemPrompt = take('--system-prompt');
        break;
      case '--append-system-prompt':
        options.appendSystemPrompt = take('--append-system-prompt');
        break;
      case '--add-dir': {
        const directory = take('--add-dir');
        if (directory !== undefined) options.allowDirs.push(directory);
        break;
      }
      case '--verbose':
        options.verbose = true;
        break;
      case '--replay-user-messages':
        options.replayUserMessages = true;
        break;
      case '--include-partial-messages':
        options.includePartialMessages = true;
        break;
      case '--dangerously-skip-permissions':
        options.dangerouslySkipPermissions = true;
        break;
      case '--':
        positionals.push(...argv.slice(index + 1));
        index = argv.length;
        break;
      default:
        if (IGNORED_VALUE_FLAGS.has(arg)) {
          take(arg);
        } else if (IGNORED_BOOLEAN_FLAGS.has(arg)) {
          options.ignoredFlags.push(arg);
        } else if (arg.startsWith('-') && arg !== '-') {
          options.ignoredFlags.push(arg);
        } else {
          positionals.push(arg);
        }
    }
  }

  if (prompt === undefined && positionals.length > 0) prompt = positionals.join(' ');
  options.prompt = prompt;

  // Model: an explicit DSH target wins; a provider/model passes through; a
  // Claude alias (sonnet, claude-sonnet-4, ...) falls back to the DSH default.
  const envModel = envText(env, 'DSH_ATTACH_MODEL');
  const rawModel = options.rawModel;
  options.model = envModel
    ?? (typeof rawModel === 'string' && rawModel.includes('/') ? rawModel : undefined);

  // Permission: environment first, otherwise a safe mode mapping. Claude's
  // bypassPermissions is never turned into danger-full-access here.
  options.permissionMode = mapClaudePermissionMode(options.rawPermissionMode);
  const envPermission = envText(env, 'DSH_ATTACH_PERMISSION');
  options.permission = envPermission ?? options.permissionMode;

  // Remote target selection.
  options.remote = envText(env, 'DSH_ATTACH_REMOTE');
  options.ssh = envText(env, 'DSH_ATTACH_SSH');
  options.profile = envText(env, 'DSH_ATTACH_PROFILE');
  options.approvals = envText(env, 'DSH_ATTACH_APPROVALS') ?? 'deny';
  options.approvalRules = envText(env, 'DSH_ATTACH_APPROVAL_RULES');

  const envCacheRoot = envText(env, 'DSH_ATTACH_CACHE_ROOT');
  options.cacheRoot = envCacheRoot ?? '@session';
  options.cacheRootExplicit = envCacheRoot !== undefined;

  const envAllowDirs = splitAllowDirs(env?.DSH_ATTACH_ALLOW_DIRS);
  options.allowDirs = uniqueStrings([...options.allowDirs, ...envAllowDirs]);

  // Orchestrators own timeouts and send SIGTERM; default to no internal cap.
  const envTimeout = envText(env, 'DSH_ATTACH_TIMEOUT');
  options.timeoutMs = 0;
  if (envTimeout !== undefined) {
    const seconds = Number(envTimeout);
    options.timeoutMs = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : NaN;
  }

  const envWaitSubagents = envText(env, 'DSH_ATTACH_WAIT_SUBAGENTS');
  options.waitSubagents = envWaitSubagents === undefined
    ? true
    : !['0', 'false', 'off', 'no'].includes(envWaitSubagents.toLowerCase());

  return options;
}

/**
 * Resolve the local/remote target and any alias-provided connection fields.
 *
 * @param {Record<string, any>} options - parsed adapter options
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{remote: boolean, ssh?: string, sshOpts: string[], remoteBin?: string,
 *   profile?: string, endpoint?: string, cacheRoot: string|null,
 *   allowDirs: string[], remoteAlias?: string}}
 */
export function resolveClaudeTarget(options = {}, env = process.env) {
  const target = {
    remote: false,
    ssh: options.ssh,
    sshOpts: Array.isArray(options.sshOpts) ? [...options.sshOpts] : [],
    remoteBin: options.remoteBin,
    profile: options.profile,
    endpoint: options.endpoint,
    cacheRoot: options.cacheRoot ?? '@session',
    allowDirs: [],
    remoteAlias: undefined,
  };

  if (typeof options.remote === 'string' && options.remote !== '') {
    let remotes;
    try {
      remotes = loadRemotesSync(resolveRemotesPath(env));
    } catch (error) {
      throw new AttachError(
        `cannot read remote aliases: ${messageOf(error)}`,
        'attach/remote-alias',
      );
    }
    const alias = resolveRemoteAlias(options.remote, remotes);
    if (alias === null) {
      const names = Object.keys(remotes).sort();
      const configured = names.length === 0
        ? 'no aliases are configured'
        : `configured aliases: ${names.join(', ')}`;
      throw new AttachError(
        `unknown remote alias ${JSON.stringify(options.remote)} (${configured})`,
        'attach/remote-alias',
      );
    }
    const merged = mergeRemoteOptions(alias, {
      sshOpts: target.sshOpts,
      remoteBin: target.remoteBin,
      profile: target.profile,
      endpoint: target.endpoint,
      cacheRoot: options.cacheRootExplicit ? options.cacheRoot : undefined,
    });
    target.ssh = merged.ssh;
    target.sshOpts = Array.isArray(merged.sshOpts) ? merged.sshOpts : [];
    target.remoteBin = merged.remoteBin;
    target.profile = merged.profile;
    target.endpoint = merged.endpoint;
    target.cacheRoot = options.cacheRootExplicit
      ? options.cacheRoot
      : (merged.cacheRoot ?? options.cacheRoot ?? '@session');
    target.remoteAlias = alias.name;
  }

  target.remote = typeof target.ssh === 'string' && target.ssh.trim() !== '';
  if (target.remote) {
    target.ssh = target.ssh.trim();
    if (target.cacheRoot === '@cwd') {
      throw new AttachError(
        'DSH_ATTACH_CACHE_ROOT=@cwd is unavailable with a remote target; use @session or an explicit remote path',
        'attach/cache-root',
      );
    }
  } else {
    try {
      target.cacheRoot = resolveCacheRootOption(target.cacheRoot, process.cwd());
    } catch (error) {
      throw new AttachError(`invalid cache root: ${messageOf(error)}`, 'attach/cache-root');
    }
  }

  target.allowDirs = uniqueStrings((options.allowDirs ?? []).map((directory) => (
    typeof directory === 'string'
      ? (target.remote ? directory.trim() : expandHomePath(directory).trim())
      : ''
  )));

  return target;
}

/**
 * Connect to the local or remote Host.
 *
 * @param {ReturnType<typeof resolveClaudeTarget>} target
 * @param {{env?: NodeJS.ProcessEnv, stderr?: {write: Function}}} [io]
 * @returns {Promise<AttachClient>}
 */
export async function connectClaudeTarget(target, {
  env = process.env,
  stderr = process.stderr,
} = {}) {
  const client = new AttachClient();
  try {
    if (target.remote) {
      await client.connect({
        ssh: target.ssh,
        sshOpts: target.sshOpts,
        remoteBin: target.remoteBin,
        endpoint: target.endpoint,
        profile: target.profile,
        // Orchestrators are non-interactive: a password prompt must fail fast.
        batchMode: true,
        timeoutMs: 15_000,
      });
    } else {
      await connectWithAutostart(client, {
        endpoint: target.endpoint,
        profile: target.profile,
      }, {
        autoStart: env.DSH_ATTACH_NO_START !== '1',
        onLaunch: (launch) => stderr.write(`dsh-attach-claude: starting ${launch.label}...\n`),
        onWait: (timeoutMs) => stderr.write(
          `dsh-attach-claude: waiting up to ${Math.round(timeoutMs / 1000)}s for the attach bridge...\n`,
        ),
      });
    }
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (typeof block === 'string') {
      text += block;
    } else if (block !== null && typeof block === 'object'
      && (block.type === 'text' || block.type === 'input_text')
      && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text;
}

/**
 * Extract the prompt from one Claude stream-json input object.
 *
 * @param {unknown} value
 * @returns {string|null} prompt text, or null for any other frame
 */
export function streamJsonUserText(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value.message;
  const isUserType = value.type === 'user';
  const isUserRole = message !== null && typeof message === 'object' && message.role === 'user';
  if (!isUserType && !isUserRole) return null;
  const content = message !== null && typeof message === 'object'
    ? message.content
    : value.content;
  const text = textOfContent(content);
  return text.trim() === '' ? null : text;
}

/**
 * Parse one NDJSON line from Claude's stream-json input.
 *
 * Invalid and non-user frames return null: control frames and assistant
 * echoes are common and must not break a session.
 *
 * @param {string} line
 * @returns {string|null}
 */
export function parseStreamJsonLine(line) {
  if (typeof line !== 'string') return null;
  const text = line.replace(/^\uFEFF/u, '').trim();
  if (text === '') return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return streamJsonUserText(value);
}

/**
 * Read sequential user prompts from one open stream-json stdin stream.
 *
 * @param {AsyncIterable<Buffer|string>} stream
 * @returns {AsyncGenerator<string>}
 */
export async function* readStreamJsonInput(stream) {
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  const takeLine = (line) => parseStreamJsonLine(line);
  for await (const chunk of stream) {
    buffer += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const prompt = takeLine(line);
      if (prompt !== null) yield prompt;
    }
  }
  buffer += decoder.end();
  if (buffer.trim() !== '') {
    const prompt = takeLine(buffer);
    if (prompt !== null) yield prompt;
  }
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function usageNumber(usage, keys) {
  for (const key of keys) {
    const number = Number(usage?.[key]);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

/**
 * Map DSH camelCase usage onto Claude's snake_case result usage.
 *
 * @param {unknown} usage
 * @returns {{input_tokens: number, output_tokens: number,
 *   cache_read_input_tokens: number, cache_creation_input_tokens: number}}
 */
export function mapClaudeUsage(usage) {
  return {
    input_tokens: usageNumber(usage, ['input_tokens', 'inputTokens']),
    output_tokens: usageNumber(usage, ['output_tokens', 'outputTokens']),
    cache_read_input_tokens: usageNumber(usage, [
      'cache_read_input_tokens',
      'cacheReadInputTokens',
      'cacheReadTokens',
    ]),
    cache_creation_input_tokens: usageNumber(usage, [
      'cache_creation_input_tokens',
      'cacheCreationInputTokens',
      'cacheCreationTokens',
    ]),
  };
}

function failureReason(result) {
  const reason = typeof result?.reason === 'string' ? result.reason : '';
  return reason === '' ? 'turn failed' : `turn ended: ${reason}`;
}

/**
 * Build Claude Code's final `result` frame.
 *
 * @param {Record<string, any>} result - a `runExec` result
 * @param {{sessionId?: string|null}} [fallback]
 * @returns {Record<string, any>}
 */
export function buildClaudeResult(result = {}, { sessionId = null } = {}) {
  const ok = result?.ok === true;
  const resultSessionId = typeof result?.sessionId === 'string' && result.sessionId !== ''
    ? result.sessionId
    : (typeof sessionId === 'string' && sessionId !== '' ? sessionId : null);
  let text;
  if (ok) {
    text = typeof result?.text === 'string' ? result.text : '';
  } else {
    text = failureText(result?.failure);
    if (text === '' && typeof result?.text === 'string' && result.text !== '') text = result.text;
    if (text === '') text = failureReason(result);
  }
  return {
    type: 'result',
    subtype: ok ? 'success' : 'error_during_execution',
    is_error: !ok,
    session_id: resultSessionId,
    result: text,
    num_turns: toCount(result?.turn),
    usage: mapClaudeUsage(result?.usage),
  };
}

/**
 * Build a `result` frame for a fatal connection/runtime error.
 *
 * @param {unknown} error
 * @param {{sessionId?: string|null, turn?: number, usage?: unknown}} [facts]
 * @returns {Record<string, any>}
 */
export function buildClaudeErrorResult(error, {
  sessionId = undefined,
  turn = 0,
  usage = null,
} = {}) {
  const resultSessionId = typeof sessionId === 'string' && sessionId !== ''
    ? sessionId
    : (typeof error?.sessionId === 'string' && error.sessionId !== '' ? error.sessionId : null);
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    session_id: resultSessionId,
    result: messageOf(error) || 'exec failed',
    num_turns: toCount(turn),
    usage: mapClaudeUsage(usage),
  };
}

/** Parse one tool-use arguments string into an object. */
export function parseClaudeToolInput(argumentsValue) {
  if (argumentsValue === undefined || argumentsValue === null) return {};
  if (typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) {
    return argumentsValue;
  }
  if (typeof argumentsValue === 'string') {
    try {
      const parsed = JSON.parse(argumentsValue);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to the raw fallback below.
    }
  }
  return { raw: argumentsValue };
}

function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

/**
 * Translate `runExec` callbacks into Claude Code stream-json frames.
 *
 * Text and reasoning deltas are accumulated and flushed on a short timer, and
 * immediately before a tool call or a final result, so consumers render live
 * progress without receiving one JSON line per token.
 */
export class ClaudeStreamWriter {
  constructor({
    stdout = process.stdout,
    outputFormat = 'stream-json',
    flushIntervalMs = STREAM_FLUSH_INTERVAL_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.stdout = stdout;
    this.outputFormat = outputFormat;
    this.flushIntervalMs = Number.isFinite(flushIntervalMs) && flushIntervalMs >= 0
      ? flushIntervalMs
      : STREAM_FLUSH_INTERVAL_MS;
    this.setTimer = setTimer;
    this.clearTimerFn = clearTimer;
    this.sessionId = null;
    this.initialized = false;
    this.thinking = '';
    this.text = '';
    this.timer = null;
  }

  get stream() {
    return this.outputFormat === 'stream-json';
  }

  emit(frame) {
    if (this.stream) writeJsonLine(this.stdout, frame);
  }

  onSession(sessionId, facts = {}) {
    if (typeof sessionId === 'string' && sessionId !== '') this.sessionId = sessionId;
    if (this.initialized) return;
    this.initialized = true;
    if (!this.stream) return;
    this.emit({
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      cwd: typeof facts?.cwd === 'string' && facts.cwd !== '' ? facts.cwd : null,
      tools: [...CLAUDE_TOOLS],
    });
  }

  scheduleFlush() {
    if (!this.stream || this.timer !== null) return;
    if (this.thinking === '' && this.text === '') return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, this.flushIntervalMs);
  }

  cancelTimer() {
    if (this.timer === null) return;
    this.clearTimerFn(this.timer);
    this.timer = null;
  }

  flush() {
    this.cancelTimer();
    if (this.thinking === '' && this.text === '') return;
    const content = [];
    if (this.thinking !== '') content.push({ type: 'thinking', thinking: this.thinking });
    if (this.text !== '') content.push({ type: 'text', text: this.text });
    this.thinking = '';
    this.text = '';
    if (content.length === 0) return;
    this.emit({
      type: 'assistant',
      session_id: this.sessionId,
      message: { role: 'assistant', content },
    });
  }

  onReasoningDelta(delta) {
    const text = typeof delta === 'string' ? delta : delta?.text;
    if (typeof text !== 'string' || text === '') return;
    this.thinking += text;
    this.scheduleFlush();
  }

  onTextDelta(delta) {
    const text = typeof delta === 'string' ? delta : delta?.text;
    if (typeof text !== 'string' || text === '') return;
    this.text += text;
    this.scheduleFlush();
  }

  onToolCall(call = {}) {
    this.flush();
    this.emit({
      type: 'assistant',
      session_id: this.sessionId,
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: typeof call.callId === 'string' ? call.callId : String(call.callId ?? ''),
          name: typeof call.name === 'string' ? call.name : 'tool',
          input: parseClaudeToolInput(call.arguments),
        }],
      },
    });
  }

  onToolResult(result = {}) {
    this.flush();
    this.emit({
      type: 'user',
      session_id: this.sessionId,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: typeof result.callId === 'string' ? result.callId : String(result.callId ?? ''),
          content: typeof result.output === 'string' ? result.output : '',
          is_error: result.ok !== true,
        }],
      },
    });
  }

  finish(result = {}) {
    this.flush();
    const frame = buildClaudeResult(result, { sessionId: this.sessionId });
    this.emit(frame);
    return frame;
  }

  fail(error, facts = {}) {
    this.flush();
    const frame = buildClaudeErrorResult(error, {
      sessionId: facts.sessionId ?? this.sessionId,
      turn: facts.turn,
      usage: facts.usage,
    });
    this.emit(frame);
    return frame;
  }

  dispose() {
    this.cancelTimer();
  }
}

function systemPromptFor(options) {
  const parts = [];
  if (typeof options.systemPrompt === 'string' && options.systemPrompt !== '') {
    parts.push(options.systemPrompt);
  }
  if (typeof options.appendSystemPrompt === 'string' && options.appendSystemPrompt !== '') {
    parts.push(options.appendSystemPrompt);
  }
  return parts.join('\n\n');
}

async function readPromptFromStdin(stdin) {
  if (stdin?.isTTY === true) {
    throw usageError('no prompt provided; pass -p <prompt> or pipe one on stdin');
  }
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Map an adapter/runtime failure to a process exit code. */
export function claudeExitCode(error) {
  if (error?.signal === 'SIGTERM') return 143;
  if (error?.code === 'attach/exec-timeout') return 124;
  if (error?.code === 'attach/exec-interrupted') return 130;
  if (error?.code === 'attach/claude-usage') return 2;
  return 1;
}

function validateClaudeOptions(options) {
  if (!OUTPUT_FORMATS.has(options.outputFormat)) {
    throw usageError('--output-format must be one of text, json, stream-json');
  }
  if (!INPUT_FORMATS.has(options.inputFormat)) {
    throw usageError('--input-format must be one of text, stream-json');
  }
  if (options.permission !== undefined && !isPermissionPreset(options.permission)) {
    throw usageError(
      `permission must be one of read-only, workspace-write, danger-full-access, auto (got ${JSON.stringify(options.permission)})`,
    );
  }
  if (!APPROVAL_MODES.has(options.approvals)) {
    throw usageError('DSH_ATTACH_APPROVALS must be "deny" or "host"');
  }
  if (options.model !== undefined && parseModelSelection(options.model) === null) {
    throw usageError('DSH_ATTACH_MODEL (or --model) must use the provider/model form');
  }
  if (options.resume !== undefined && (typeof options.resume !== 'string' || options.resume.trim() === '')) {
    throw usageError('--resume needs a session id');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw usageError('DSH_ATTACH_TIMEOUT must be a non-negative number of seconds (0 disables the timeout)');
  }
}

function redactClaudeArgv(argv) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === '--token' || arg === '--system-prompt' || arg === '--append-system-prompt') {
      out.push(arg);
      if (index + 1 < argv.length) {
        out.push('<redacted>');
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--token=') || arg.startsWith('--system-prompt=') || arg.startsWith('--append-system-prompt=')) {
      out.push(`${arg.slice(0, arg.indexOf('='))}=<redacted>`);
      continue;
    }
    if (arg === '-p' || arg === '--print') {
      out.push(arg);
      const next = argv[index + 1];
      if (next !== undefined && !looksLikeOption(next)) {
        out.push('<prompt>');
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('-p=') || arg.startsWith('--print=')) {
      out.push(`${arg.slice(0, arg.indexOf('='))}=<prompt>`);
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * Run the adapter and return a process exit code without exiting.
 *
 * `client` and `runner` are injectable for tests; production callers leave both
 * unset so the adapter connects with `AttachClient` and drives `runExec`.
 *
 * @param {string[]} argv
 * @param {{stdin?: AsyncIterable<Buffer|string>, stdout?: {write: Function},
 *   stderr?: {write: Function}, env?: NodeJS.ProcessEnv,
 *   client?: object, runner?: Function, connect?: Function,
 *   log?: {event: Function}|null,
 *   flushIntervalMs?: number}} [io]
 * @returns {Promise<number>}
 */
export async function runClaudeCompat(argv = [], {
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  client,
  runner,
  connect = connectClaudeTarget,
  log,
  flushIntervalMs = STREAM_FLUSH_INTERVAL_MS,
} = {}) {
  const explicitLog = typeof env?.DSH_ATTACH_LOG === 'string' && env.DSH_ATTACH_LOG.trim() !== '';
  const clientLog = log !== undefined
    ? log
    : (client === undefined && runner === undefined) || explicitLog
      ? new ClientLog(resolveLogPath(env))
      : null;

  let options;
  try {
    options = parseClaudeArgs(argv, env);
  } catch (error) {
    clientLog?.event('claude.usage-error', { argv: redactClaudeArgv(argv), error: messageOf(error) });
    stderr.write(`dsh-attach-claude: ${messageOf(error)}\n`);
    return 2;
  }

  if (options.version) {
    stdout.write(`${CLAUDE_COMPAT_VERSION} (dsh-attach-claude ${VERSION})\n`);
    return 0;
  }
  if (options.help) {
    stdout.write(CLAUDE_HELP);
    return 0;
  }

  let target;
  let approvalRules = null;
  try {
    validateClaudeOptions(options);
    target = resolveClaudeTarget(options, env);
    if (typeof options.approvalRules === 'string' && options.approvalRules !== '') {
      approvalRules = await loadExecApprovalRules(options.approvalRules);
    }
  } catch (error) {
    // Argument/config errors happen before a Session exists; match Claude's
    // usage-error behavior and keep stdout protocol-free.
    clientLog?.event('claude.usage-error', { argv: redactClaudeArgv(argv), error: messageOf(error) });
    stderr.write(`dsh-attach-claude: ${messageOf(error)}\n`);
    return 2;
  }

  const writer = new ClaudeStreamWriter({
    stdout,
    outputFormat: options.outputFormat,
    flushIntervalMs,
  });
  const forwardedEnv = {};
  if (env !== null && typeof env === 'object') {
    for (const [key, value] of Object.entries(env)) {
      if (!/^(?:HERDR|MULTICA)_[A-Z0-9_]+$/u.test(key)) continue;
      if (typeof value !== 'string' || value === '') continue;
      forwardedEnv[key] = value;
    }
  }
  clientLog?.event('claude.start', {
    version: VERSION,
    argv: redactClaudeArgv(argv),
    cwd: process.cwd(),
    remote: target.remote,
    profile: target.profile ?? null,
    resume: options.resume ?? null,
    outputFormat: options.outputFormat,
    inputFormat: options.inputFormat,
    permission: options.permission ?? null,
    model: options.model ?? null,
    approvals: options.approvals,
    allowDirs: target.allowDirs,
    cacheRoot: target.cacheRoot ?? null,
    timeoutMs: options.timeoutMs,
    waitSubagents: options.waitSubagents,
    ignoredFlags: options.ignoredFlags,
    forwardedEnvKeys: Object.keys(forwardedEnv),
  });
  const execute = runner ?? runExec;
  const ownsClient = client === undefined;
  let activeSessionId = options.resume;
  const systemPrompt = systemPromptFor(options);

  try {
    if (ownsClient) client = await connect(target, { env, stderr });

    const runTurn = async (prompt, sessionId, first) => {
      const effectivePrompt = first && systemPrompt !== ''
        ? `${systemPrompt}\n\n${prompt}`
        : prompt;
      const reconnect = target.remote
        ? () => client.reconnect({
          ssh: target.ssh,
          sshOpts: target.sshOpts,
          remoteBin: target.remoteBin,
          endpoint: target.endpoint,
          profile: target.profile,
          batchMode: true,
          timeoutMs: 15_000,
        })
        : undefined;
      const result = await execute(client, {
        sessionId,
        prompt: effectivePrompt,
        ...(sessionId === undefined && !target.remote ? { cwd: process.cwd() } : {}),
        cacheRoot: target.cacheRoot ?? undefined,
        timeoutMs: options.timeoutMs,
        waitSubagents: options.waitSubagents,
        ...(Object.keys(forwardedEnv).length > 0 ? { env: forwardedEnv } : {}),
        approvals: options.approvals,
        approvalRules,
        allowDirs: target.allowDirs,
        permission: options.permission,
        model: options.model,
        ...(target.remote ? {
          ssh: target.ssh,
          sshOpts: target.sshOpts,
          remoteBin: target.remoteBin,
          profile: target.profile,
          ...(reconnect === undefined ? {} : { reconnect }),
        } : {}),
        warn: (message) => stderr.write(`dsh-attach-claude: ${message}\n`),
        onSession: (id, facts) => writer.onSession(id, facts),
        onTextDelta: (delta) => writer.onTextDelta(delta),
        onReasoningDelta: (delta) => writer.onReasoningDelta(delta),
        onToolCall: (call) => writer.onToolCall(call),
        onToolResult: (toolResult) => writer.onToolResult(toolResult),
      });
      const resultSessionId = typeof result?.sessionId === 'string' && result.sessionId !== ''
        ? result.sessionId
        : (writer.sessionId ?? sessionId ?? null);
      activeSessionId = resultSessionId;
      const frame = writer.finish({ ...result, sessionId: resultSessionId });

      if (options.outputFormat === 'json') writeJsonLine(stdout, frame);
      if (options.outputFormat === 'text' && result?.ok === true && frame.result !== '') {
        stdout.write(frame.result.endsWith('\n') ? frame.result : `${frame.result}\n`);
      }
      if (result?.ok !== true) stderr.write(`dsh-attach-claude: ${frame.result}\n`);
      return { code: result?.ok === true ? 0 : 1, sessionId: resultSessionId };
    };

    if (options.inputFormat === 'stream-json'
      && !(stdin?.isTTY === true && options.prompt !== undefined)) {
      let first = true;
      let code = 0;
      for await (const prompt of readStreamJsonInput(stdin)) {
        const outcome = await runTurn(prompt, activeSessionId, first);
        first = false;
        activeSessionId = outcome.sessionId;
        if (outcome.code !== 0) code = outcome.code;
      }
      if (first && options.prompt !== undefined) {
        const outcome = await runTurn(options.prompt, activeSessionId, true);
        code = outcome.code;
      }
      clientLog?.event('claude.end', { code, sessionId: activeSessionId ?? null });
      return code;
    }

    const prompt = options.prompt ?? await readPromptFromStdin(stdin);
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw usageError('no prompt provided; pass -p <prompt> or pipe one on stdin');
    }
    const outcome = await runTurn(prompt, activeSessionId, true);
    clientLog?.event('claude.end', { code: outcome.code, sessionId: activeSessionId ?? null });
    return outcome.code;
  } catch (error) {
    const frame = writer.fail(error, {
      sessionId: typeof error?.sessionId === 'string' ? error.sessionId : activeSessionId,
    });
    if (options.outputFormat === 'json') writeJsonLine(stdout, frame);
    const code = claudeExitCode(error);
    clientLog?.event('claude.end', {
      code,
      sessionId: frame.session_id ?? null,
      error: messageOf(error),
    });
    stderr.write(`dsh-attach-claude: ${messageOf(error)}\n`);
    return code;
  } finally {
    writer.dispose();
    if (ownsClient) client?.close?.();
  }
}

/**
 * Binary entry point: run the adapter and set `process.exitCode`.
 *
 * @param {string[]} argv
 * @param {Parameters<typeof runClaudeCompat>[1]} [io]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const stderr = io.stderr ?? process.stderr;
  let code = 1;
  try {
    code = await runClaudeCompat(argv, io);
  } catch (error) {
    stderr.write(`dsh-attach-claude: ${messageOf(error)}\n`);
    code = 1;
  }
  process.exitCode = code;
  return code;
}
