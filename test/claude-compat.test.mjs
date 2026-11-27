import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  CLAUDE_COMPAT_VERSION,
  ClaudeStreamWriter,
  buildClaudeResult,
  parseClaudeArgs,
  parseClaudeToolInput,
  parseStreamJsonLine,
  readStreamJsonInput,
  resolveClaudeTarget,
  runClaudeCompat,
  streamJsonUserText,
} from '../lib/client/claude-compat.js';
import { VERSION } from '../lib/shared/version.js';

function capture() {
  const chunks = [];
  return {
    stream: {
      write(text) {
        chunks.push(String(text));
        return true;
      },
    },
    text: () => chunks.join(''),
    lines: () => chunks.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  };
}

const client = { close() {} };
const zeroUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function success(sessionId, text, overrides = {}) {
  return {
    ok: true,
    sessionId,
    turn: 1,
    text,
    reason: 'complete',
    failure: null,
    usage: { inputTokens: 1, outputTokens: 2 },
    interactions: [],
    ...overrides,
  };
}

test('parseClaudeArgs recognizes Claude flags and ignores future ones', () => {
  const options = parseClaudeArgs([
    '-p', 'hello',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--resume', 'session-1',
    '--model', 'provider/model',
    '--permission-mode', 'plan',
    '--system-prompt', 'SYS',
    '--append-system-prompt', 'APP',
    '--verbose',
    '--replay-user-messages',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
    '--add-dir', '/one',
    '--add-dir', '/two',
    '--mcp-config', '{}',
    '--strict-mcp-config',
    '--max-turns', '4',
    '--future-flag',
  ], {});

  assert.equal(options.prompt, 'hello');
  assert.equal(options.print, true);
  assert.equal(options.outputFormat, 'stream-json');
  assert.equal(options.inputFormat, 'stream-json');
  assert.equal(options.resume, 'session-1');
  assert.equal(options.model, 'provider/model');
  assert.equal(options.rawPermissionMode, 'plan');
  assert.equal(options.permissionMode, 'read-only');
  assert.equal(options.permission, 'read-only');
  assert.equal(options.systemPrompt, 'SYS');
  assert.equal(options.appendSystemPrompt, 'APP');
  assert.equal(options.verbose, true);
  assert.equal(options.replayUserMessages, true);
  assert.equal(options.includePartialMessages, true);
  assert.equal(options.dangerouslySkipPermissions, true);
  assert.deepEqual(options.allowDirs, ['/one', '/two']);
  assert.equal(options.ignoredFlags.includes('--future-flag'), true);
});

test('parseClaudeArgs supports optional -p prompts, positionals, and equals forms', () => {
  assert.equal(parseClaudeArgs(['-p'], {}).prompt, undefined);
  assert.equal(parseClaudeArgs(['--print', 'hello'], {}).prompt, 'hello');
  assert.equal(parseClaudeArgs(['hello', 'world'], {}).prompt, 'hello world');
  assert.equal(parseClaudeArgs(['--print', '--verbose', 'hello'], {}).prompt, 'hello');
  assert.equal(parseClaudeArgs(['--output-format=json'], {}).outputFormat, 'json');
  assert.equal(parseClaudeArgs(['-p=hello'], {}).prompt, 'hello');
  assert.equal(parseClaudeArgs(['-r=session-3'], {}).resume, 'session-3');
  assert.equal(parseClaudeArgs(['--resume=session-2'], {}).resume, 'session-2');
  assert.equal(parseClaudeArgs(['--add-dir=/three'], {}).allowDirs[0], '/three');
  assert.equal(parseClaudeArgs(['-v'], {}).version, true);
  assert.equal(parseClaudeArgs(['--help'], {}).help, true);
});

test('parseClaudeArgs maps Claude model aliases and permission modes safely', () => {
  const alias = parseClaudeArgs(['--model', 'sonnet'], {});
  assert.equal(alias.rawModel, 'sonnet');
  assert.equal(alias.model, undefined);
  assert.equal(parseClaudeArgs(['--model', 'claude-sonnet-4'], {}).model, undefined);

  const providerModel = parseClaudeArgs(['--model', 'openrouter/anthropic/claude'], {});
  assert.equal(providerModel.model, 'openrouter/anthropic/claude');

  const mode = (value) => parseClaudeArgs(['--permission-mode', value], {}).permission;
  assert.equal(mode('plan'), 'read-only');
  assert.equal(mode('acceptEdits'), 'workspace-write');
  assert.equal(mode('default'), 'workspace-write');
  assert.equal(mode('bypassPermissions'), 'workspace-write');
  assert.equal(mode('not-a-mode'), undefined);
});

test('parseClaudeArgs applies environment overrides', () => {
  const env = {
    DSH_ATTACH_REMOTE: 'win',
    DSH_ATTACH_SSH: 'ignored@host',
    DSH_ATTACH_PROFILE: 'desktop',
    DSH_ATTACH_MODEL: 'provider/env-model',
    DSH_ATTACH_PERMISSION: 'danger-full-access',
    DSH_ATTACH_CACHE_ROOT: '/cache',
    DSH_ATTACH_APPROVALS: 'host',
    DSH_ATTACH_APPROVAL_RULES: '@default',
    DSH_ATTACH_ALLOW_DIRS: ['/one', '/two'].join(delimiter),
  };
  const options = parseClaudeArgs([
    '--model', 'provider/cli-model',
    '--permission-mode', 'plan',
  ], env);

  assert.equal(options.remote, 'win');
  assert.equal(options.ssh, 'ignored@host');
  assert.equal(options.profile, 'desktop');
  assert.equal(options.model, 'provider/env-model');
  assert.equal(options.permission, 'danger-full-access');
  assert.equal(options.cacheRoot, '/cache');
  assert.equal(options.approvals, 'host');
  assert.equal(options.approvalRules, '@default');
  assert.deepEqual(options.allowDirs, ['/one', '/two']);
});

test('parseClaudeArgs defaults the cache root to @session and forwards DSH_ATTACH_SSH', () => {
  const options = parseClaudeArgs([], { DSH_ATTACH_SSH: 'user@host' });
  assert.equal(options.ssh, 'user@host');
  assert.equal(options.cacheRoot, '@session');
  assert.equal(options.approvals, 'deny');
  assert.deepEqual(options.allowDirs, []);
});

test('--version prints the Claude compatibility version and exits 0', async () => {
  const out = capture();
  const err = capture();
  const code = await runClaudeCompat(['--version'], {
    stdout: out.stream,
    stderr: err.stream,
    env: {},
  });
  assert.equal(code, 0);
  assert.equal(out.text(), `${CLAUDE_COMPAT_VERSION} (dsh-attach-claude ${VERSION})\n`);
  assert.equal(err.text(), '');
});

test('extracts user prompts from stream-json objects', () => {
  assert.equal(streamJsonUserText({
    type: 'user',
    message: { role: 'user', content: 'hello' },
  }), 'hello');
  assert.equal(streamJsonUserText({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }],
    },
  }), 'hello world');
  assert.equal(streamJsonUserText({
    type: 'user',
    message: { role: 'user', content: '   ' },
  }), null);
  assert.equal(streamJsonUserText({
    type: 'assistant',
    message: { role: 'assistant', content: 'ignored' },
  }), null);
  assert.equal(parseStreamJsonLine('{"type":"user","message":{"role":"user","content":"ok"}}'), 'ok');
  assert.equal(parseStreamJsonLine('not json'), null);
  assert.equal(parseStreamJsonLine('{"type":"control_request"}'), null);
});

test('reads multiple sequential user messages from one stream-json stdin', async () => {
  const stream = Readable.from([
    '{"type":"user","message":{"role":"user","content":"one"}}\r\n',
    '{"type":"ignore"}\n',
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"tw',
    'o"}]}}\n',
  ]);
  const prompts = [];
  for await (const prompt of readStreamJsonInput(stream)) prompts.push(prompt);
  assert.deepEqual(prompts, ['one', 'two']);
});

test('stream-json output emits init, throttled assistant, tool frames, and result', () => {
  const out = capture();
  const writer = new ClaudeStreamWriter({ stdout: out.stream, flushIntervalMs: 60_000 });
  try {
    writer.onSession('session-1', { cwd: '/work' });
    assert.deepEqual(out.lines(), [{
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
      cwd: '/work',
      tools: ['bash', 'read', 'write', 'edit'],
    }]);

    writer.onReasoningDelta({ text: 'thinking ' });
    writer.onTextDelta({ text: 'answer' });
    // Still throttled: no assistant frame yet.
    assert.equal(out.lines().length, 1);

    writer.onToolCall({ callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' });
    let lines = out.lines();
    assert.equal(lines.length, 3);
    assert.deepEqual(lines[1], {
      type: 'assistant',
      session_id: 'session-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thinking ' },
          { type: 'text', text: 'answer' },
        ],
      },
    });
    assert.deepEqual(lines[2], {
      type: 'assistant',
      session_id: 'session-1',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call-1',
          name: 'bash',
          input: { command: 'ls' },
        }],
      },
    });

    writer.onToolCall({ callId: 'call-2', name: 'read', arguments: 'not-json' });
    lines = out.lines();
    assert.deepEqual(lines.at(-1).message.content[0].input, { raw: 'not-json' });

    writer.onToolResult({ callId: 'call-1', name: 'bash', ok: false, output: 'boom' });
    lines = out.lines();
    assert.deepEqual(lines.at(-1), {
      type: 'user',
      session_id: 'session-1',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: 'boom',
          is_error: true,
        }],
      },
    });

    const frame = writer.finish({
      ok: true,
      sessionId: 'session-1',
      turn: 2,
      text: 'answer',
      usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7 },
    });
    assert.deepEqual(frame, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'session-1',
      result: 'answer',
      num_turns: 2,
      usage: {
        input_tokens: 5,
        output_tokens: 6,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 0,
      },
    });
    assert.deepEqual(out.lines().at(-1), frame);
  } finally {
    writer.dispose();
  }
});

test('stream-json assistant deltas flush on the throttle timer', async () => {
  const out = capture();
  const writer = new ClaudeStreamWriter({ stdout: out.stream, flushIntervalMs: 10 });
  try {
    writer.onSession('session-1', { cwd: '/work' });
    writer.onTextDelta({ text: 'late' });
    assert.equal(out.lines().length, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lines = out.lines();
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[1].message.content, [{ type: 'text', text: 'late' }]);
  } finally {
    writer.dispose();
  }
});

test('stream-json fatal errors emit an error result frame and map the exit code', async () => {
  const out = capture();
  const err = capture();
  const error = Object.assign(new Error('interrupted'), {
    code: 'attach/exec-interrupted',
    signal: 'SIGTERM',
  });
  const code = await runClaudeCompat(['-p', 'hi', '--output-format', 'stream-json'], {
    stdin: Readable.from([]),
    stdout: out.stream,
    stderr: err.stream,
    env: {},
    client,
    runner: async () => { throw error; },
  });
  assert.equal(code, 143);
  assert.deepEqual(out.lines().at(-1), {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    session_id: null,
    result: 'interrupted',
    num_turns: 0,
    usage: zeroUsage,
  });
  assert.match(err.text(), /interrupted/u);
});

test('failed turns emit a Claude error result and exit 1', async () => {
  const out = capture();
  const err = capture();
  const code = await runClaudeCompat(['-p', 'hi', '--output-format', 'stream-json'], {
    stdin: Readable.from([]),
    stdout: out.stream,
    stderr: err.stream,
    env: {},
    client,
    runner: async () => ({
      ok: false,
      sessionId: 'session-1',
      turn: 1,
      text: 'partial answer',
      reason: 'error',
      failure: { message: 'model failed', code: 'provider/error', status: 500 },
    }),
  });
  assert.equal(code, 1);
  const frame = out.lines().at(-1);
  assert.equal(frame.type, 'result');
  assert.equal(frame.subtype, 'error_during_execution');
  assert.equal(frame.is_error, true);
  assert.equal(frame.session_id, 'session-1');
  assert.match(frame.result, /model failed/u);
  assert.match(err.text(), /model failed/u);
});

test('stream-json input runs sequential turns against the established session', async () => {
  const out = capture();
  const err = capture();
  const turns = [];
  const runner = async (_client, options) => {
    turns.push({ sessionId: options.sessionId, prompt: options.prompt });
    const sessionId = options.sessionId ?? 'session-1';
    options.onSession(sessionId, { cwd: '/work' });
    options.onReasoningDelta({ sessionId, text: 'thinking' });
    options.onTextDelta({ sessionId, text: `reply ${turns.length}` });
    return {
      ok: true,
      sessionId,
      turn: turns.length,
      text: `reply ${turns.length}`,
      reason: 'complete',
      failure: null,
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 },
      interactions: [],
    };
  };
  const stdin = Readable.from([
    '{"type":"user","message":{"role":"user","content":"one"}}\n',
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"two"}]}}\n',
  ]);
  const code = await runClaudeCompat([
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
  ], {
    stdin,
    stdout: out.stream,
    stderr: err.stream,
    env: {},
    client,
    runner,
    flushIntervalMs: 60_000,
  });

  assert.equal(code, 0);
  assert.deepEqual(turns, [
    { sessionId: undefined, prompt: 'one' },
    { sessionId: 'session-1', prompt: 'two' },
  ]);
  const lines = out.lines();
  assert.equal(lines.filter((line) => line.type === 'system').length, 1);
  assert.equal(lines.filter((line) => line.type === 'result').length, 2);
  assert.equal(lines[0].session_id, 'session-1');
  assert.equal(lines.at(-1).session_id, 'session-1');
  assert.equal(err.text(), '');
});

test('plain prompts prepend system instructions and text output prints the result', async () => {
  const out = capture();
  const err = capture();
  let seenPrompt;
  const code = await runClaudeCompat([
    '-p', 'hello',
    '--system-prompt', 'SYS',
    '--append-system-prompt', 'APP',
  ], {
    stdin: Readable.from([]),
    stdout: out.stream,
    stderr: err.stream,
    env: {},
    client,
    runner: async (_client, options) => {
      seenPrompt = options.prompt;
      return success('session-1', 'done');
    },
  });
  assert.equal(code, 0);
  assert.equal(seenPrompt, 'SYS\n\nAPP\n\nhello');
  assert.equal(out.text(), 'done\n');
  assert.equal(err.text(), '');
});

test('json output prints only the final result object', async () => {
  const out = capture();
  const err = capture();
  const code = await runClaudeCompat(['-p', 'hi', '--output-format', 'json'], {
    stdin: Readable.from([]),
    stdout: out.stream,
    stderr: err.stream,
    env: {},
    client,
    runner: async () => success('session-1', 'done', {
      turn: 3,
      usage: { inputTokens: 7, outputTokens: 8, cacheReadTokens: 9 },
    }),
  });
  assert.equal(code, 0);
  assert.equal(out.lines().length, 1);
  assert.deepEqual(out.lines()[0], {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'session-1',
    result: 'done',
    num_turns: 3,
    usage: {
      input_tokens: 7,
      output_tokens: 8,
      cache_read_input_tokens: 9,
      cache_creation_input_tokens: 0,
    },
  });
  assert.equal(err.text(), '');
});

test('resolves a DSH_ATTACH_REMOTE alias for connection options', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-claude-compat-'));
  try {
    const remotesPath = join(dir, 'remotes.toml');
    await writeFile(remotesPath, [
      '[remotes.win]',
      'ssh = "user@host"',
      'ssh_opts = ["-p", "2222"]',
      'profile = "desktop"',
      'cache_root = "@session"',
      '',
    ].join('\n'), 'utf8');
    const env = { DSH_ATTACH_REMOTE: 'win', DSH_ATTACH_REMOTES: remotesPath };
    const target = resolveClaudeTarget(parseClaudeArgs([], env), env);
    assert.equal(target.remote, true);
    assert.equal(target.ssh, 'user@host');
    assert.deepEqual(target.sshOpts, ['-p', '2222']);
    assert.equal(target.profile, 'desktop');
    assert.equal(target.cacheRoot, '@session');
    assert.equal(target.remoteAlias, 'win');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildClaudeResult and tool-input helpers keep protocol shapes stable', () => {
  assert.deepEqual(parseClaudeToolInput('{"command":"pwd"}'), { command: 'pwd' });
  assert.deepEqual(parseClaudeToolInput({ command: 'pwd' }), { command: 'pwd' });
  assert.deepEqual(parseClaudeToolInput('[1,2]'), { raw: '[1,2]' });
  assert.deepEqual(parseClaudeToolInput(undefined), {});

  const frame = buildClaudeResult({ ok: true, sessionId: 's1', turn: 0, text: 'x' });
  assert.equal(frame.type, 'result');
  assert.equal(frame.session_id, 's1');
  assert.equal(frame.num_turns, 0);
  assert.deepEqual(frame.usage, zeroUsage);
});

test('forwards only MULTICA_* and HERDR_* environment variables to exec', async () => {
  const out = capture();
  const err = capture();
  let seenEnv;
  const code = await runClaudeCompat(['-p', 'hello'], {
    stdin: Readable.from([]),
    stdout: out.stream,
    stderr: err.stream,
    env: {
      MULTICA_TOKEN: 'mat_abc',
      MULTICA_SERVER_URL: 'https://api.multica.ai',
      MULTICA_WORKSPACE_ID: 'ws-1',
      HERDR_ENV: '1',
      PATH: '/usr/bin',
      HOME: '/Users/example',
      OPENAI_API_KEY: 'sk-nope',
      MULTICA_EMPTY: '',
    },
    client,
    runner: async (_client, options) => {
      seenEnv = options.env;
      return success('session-1', 'ok');
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(seenEnv, {
    MULTICA_TOKEN: 'mat_abc',
    MULTICA_SERVER_URL: 'https://api.multica.ai',
    MULTICA_WORKSPACE_ID: 'ws-1',
    HERDR_ENV: '1',
  });
  assert.equal(err.text(), '');
});

test('records redacted lifecycle events in ClientLog without leaking prompts or secrets', async () => {
  const out = capture();
  const err = capture();
  const events = [];
  const log = { event: (name, data) => events.push({ name, data }) };
  const code = await runClaudeCompat([
    '-p', 'secret user prompt',
    '--system-prompt', 'secret system prompt',
    '--add-dir', '/tmp/extra-repo',
    '--unknown-flag',
  ], {
    stdin: Readable.from([]),
    stdout: out.stream,
    stderr: err.stream,
    env: { MULTICA_TOKEN: 'mat_super_secret' },
    client,
    log,
    runner: async () => success('session-log-1', 'done'),
  });
  assert.equal(code, 0);
  assert.equal(events.length, 2);
  assert.equal(events[0].name, 'claude.start');
  assert.deepEqual(events[0].data.argv, [
    '-p', '<prompt>',
    '--system-prompt', '<redacted>',
    '--add-dir', '/tmp/extra-repo',
    '--unknown-flag',
  ]);
  assert.deepEqual(events[0].data.allowDirs, ['/tmp/extra-repo']);
  assert.deepEqual(events[0].data.ignoredFlags, ['--unknown-flag']);
  assert.deepEqual(events[0].data.forwardedEnvKeys, ['MULTICA_TOKEN']);
  assert.equal(JSON.stringify(events).includes('mat_super_secret'), false);
  assert.equal(JSON.stringify(events).includes('secret user prompt'), false);
  assert.deepEqual(events[1], {
    name: 'claude.end',
    data: { code: 0, sessionId: 'session-log-1' },
  });
});

test('defaults timeoutMs to 0 and honors DSH_ATTACH_TIMEOUT in seconds', async () => {
  const seen = [];
  const runWithEnv = async (env) => {
    const out = capture();
    const err = capture();
    const code = await runClaudeCompat(['-p', 'hello'], {
      stdin: Readable.from([]),
      stdout: out.stream,
      stderr: err.stream,
      env,
      client,
      runner: async (_client, options) => {
        seen.push(options.timeoutMs);
        return success('session-t1', 'ok');
      },
    });
    return { code, err: err.text() };
  };

  const def = await runWithEnv({});
  assert.equal(def.code, 0);
  const custom = await runWithEnv({ DSH_ATTACH_TIMEOUT: '120' });
  assert.equal(custom.code, 0);
  assert.deepEqual(seen, [0, 120_000]);

  const bad = await runWithEnv({ DSH_ATTACH_TIMEOUT: '-5' });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /DSH_ATTACH_TIMEOUT/u);
});

test('defaults waitSubagents to true and honors DSH_ATTACH_WAIT_SUBAGENTS=0', async () => {
  const seen = [];
  for (const env of [{}, { DSH_ATTACH_WAIT_SUBAGENTS: '0' }, { DSH_ATTACH_WAIT_SUBAGENTS: 'false' }]) {
    const out = capture();
    const err = capture();
    const code = await runClaudeCompat(['-p', 'hello'], {
      stdin: Readable.from([]),
      stdout: out.stream,
      stderr: err.stream,
      env,
      client,
      runner: async (_client, options) => {
        seen.push(options.waitSubagents);
        return success('session-sub-1', 'ok');
      },
    });
    assert.equal(code, 0);
  }
  assert.deepEqual(seen, [true, false, false]);
});
