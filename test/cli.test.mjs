import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  listSessions,
  normalizeOptions,
  parseArgs,
  runExecCommand,
  sessionListPayload,
} from '../lib/client/cli.js';

function parsed(argv) {
  return normalizeOptions(parseArgs(argv));
}

function usageError(argv, pattern) {
  assert.throws(
    () => parsed(argv),
    (error) => pattern.test(error.message),
    `expected ${argv.join(' ')} to fail`,
  );
}

function capture() {
  const chunks = [];
  return {
    stream: { write: (text) => chunks.push(String(text)) },
    text: () => chunks.join(''),
  };
}

function baseResult(overrides = {}) {
  return {
    ok: true,
    sessionId: 's1',
    turn: 1,
    text: 'done',
    reason: 'complete',
    failure: null,
    usage: { inputTokens: 1, outputTokens: 2 },
    interactions: [],
    ...overrides,
  };
}

test('parses repeatable and exec-only options', () => {
  const options = parseArgs([
    '--exec',
    '--allow-dir', '/one',
    '--allow-dir', '/two',
    '-p', 'work',
    '-o', '/tmp/answer.txt',
    '--permission', 'workspace-write',
    '--model', 'p/m',
    '--preset', 'minimal',
    '--title', 'nightly',
    '--jsonl',
  ]);
  assert.deepEqual(options.allowDirs, ['/one', '/two']);
  assert.equal(options.output, '/tmp/answer.txt');
  assert.equal(options.permission, 'workspace-write');
  assert.equal(options.model, 'p/m');
  assert.equal(options.preset, 'minimal');
  assert.equal(options.title, 'nightly');
  assert.equal(options.jsonl, true);
  assert.throws(() => parseArgs(['--nope']), /unknown option/u);
  assert.throws(() => parseArgs(['--allow-dir']), /requires a value/u);
});

test('--json works with --list and still requires --exec otherwise', () => {
  assert.equal(parsed(['--list', '--json']).json, true);
  assert.equal(parsed(['--exec', '-p', 'x', '--json']).json, true);
  usageError(['--json'], /--json requires --exec or --list/u);
});

test('rejects every exec-only flag outside --exec', () => {
  const cases = [
    [['--jsonl'], /--jsonl requires --exec/u],
    [['--allow-dir', '/tmp'], /--allow-dir requires --exec/u],
    [['--permission', 'auto'], /--permission requires --exec/u],
    [['--model', 'p/m'], /--model requires --exec/u],
    [['--preset', 'minimal'], /--preset requires --exec/u],
    [['--title', 'nightly'], /--title requires --exec/u],
    [['--prompt-file', 'prompt.md'], /--prompt-file requires --exec/u],
    [['--output', 'answer.md'], /--output requires --exec/u],
    [['--exec-timeout', '5'], /--exec-timeout requires --exec/u],
    [['--approve'], /--approve requires --exec/u],
    [['--approvals', 'host'], /--approvals requires --exec/u],
    [['--approval-rules', 'rules.toml'], /--approval-rules requires --exec/u],
  ];
  for (const [argv, pattern] of cases) usageError(argv, pattern);
});

test('validates exec flag values and incompatibilities', () => {
  usageError(['--exec', '-p', 'x', '--json', '--jsonl'], /--jsonl cannot be combined with --json/u);
  usageError(['--exec', '-p', 'x', '--jsonl', '--list'], /cannot be combined with --list/u);
  usageError(['--exec', '-p', 'x', '-f', 'prompt.md'], /--prompt and --prompt-file/u);
  usageError(['--exec', '-s', 's1', '--preset', 'minimal'], /--preset only applies to a new session/u);
  usageError(['--exec', '-s', 's1', '-p', 'x', '-C', '/work'], /--cwd only applies to a new session/u);
  usageError(['--exec', '--new', '-s', 's1', '-p', 'x'], /either --new or --session/u);
  usageError(['--exec', '--list', '-p', 'x'], /--exec cannot be combined with --list/u);
  usageError(['--exec', '-p', 'x', '--permission', 'root'], /--permission must be one of/u);
  usageError(['--exec', '-p', 'x', '--model', 'no-slash'], /provider\/model/u);
  usageError(['--exec', '-p', 'x', '--title', '   '], /--title needs/u);
  usageError(['--exec', '-p', 'x', '--preset', '  '], /--preset needs/u);
  usageError(['--exec', '-p', 'x', '--allow-dir', '  '], /--allow-dir needs/u);
  usageError(['--exec', '-p', 'x', '-o', '  '], /--output needs/u);
  usageError(['--exec', '-p', 'x', '-f', '  '], /--prompt-file needs/u);
  usageError(['--exec', '-p', 'x', '--approvals', 'auto'], /--approvals must be/u);
  usageError(['--exec', '-p', 'x', '--approvals', 'host', '--approve'], /cannot be combined with --approve/u);
  usageError(['--exec', '-p', 'x', '--exec-timeout', '-1'], /non-negative/u);
  usageError(['--exec', '-p', 'x', '-s', '  '], /--session needs/u);
});

test('expands home-relative paths and keeps @default', () => {
  const options = parsed(['--exec', '-p', 'x', '--allow-dir', '~/shared', '-o', '~/answer.txt']);
  assert.equal(options.allowDirs[0].startsWith('~'), false);
  assert.equal(options.output.startsWith('~'), false);
  assert.equal(parsed(['--exec', '-p', 'x', '--approval-rules', '@default']).approvalRules, '@default');
});

test('builds an untruncated, filtered, newest-first JSON session list', () => {
  const longId = 'session-0123456789abcdef0123456789abcdef';
  const longCwd = '/very/long/workspace/path/that/the/table/would/normally/truncate';
  const value = {
    items: [
      { sessionId: 'old', title: 'old', cwd: '/old', updatedAt: 1, running: false, blank: false },
      {
        sessionId: longId,
        title: 'new',
        cwd: longCwd,
        updatedAt: 2,
        running: true,
        blank: false,
        parentSessionId: 'parent',
        origin: 'user',
        agentPreset: 'minimal',
        model: { provider: 'p', model: 'm' },
      },
      { sessionId: 'child', updatedAt: 3, origin: 'subagent' },
    ],
  };
  const payload = sessionListPayload(value, false);
  assert.deepEqual(payload.items.map((item) => item.sessionId), [longId, 'old']);
  assert.equal(payload.items[0].sessionId.length, longId.length);
  assert.equal(payload.items[0].cwd, longCwd);
  assert.deepEqual(payload.items[0].model, { provider: 'p', model: 'm' });
  assert.equal(payload.items[0].agentPreset, 'minimal');
  assert.equal(payload.items[1].parentSessionId, null);
  assert.deepEqual(sessionListPayload(value, true).items.map((item) => item.sessionId), ['child', longId, 'old']);
});

test('--list --json prints one JSON object through the injected writer', async () => {
  const payload = { items: [{ sessionId: 's1', title: 't', cwd: '/w', updatedAt: 9 }] };
  const client = { request: async () => payload };
  const out = capture();
  await listSessions(client, false, { json: true, out: (line) => out.stream.write(`${line}\n`) });
  const value = JSON.parse(out.text().trim());
  assert.equal(value.items[0].sessionId, 's1');
  assert.equal(out.text().trim().split('\n').length, 1);
});

test('--jsonl prints one final turn.end event', async () => {
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const client = {};
  const code = await runExecCommand(client, { exec: true, jsonl: true }, {
    prompt: 'work',
    stdout: stdout.stream,
    stderr: stderr.stream,
    runner: async () => {
      calls.push('run');
      return baseResult({
        interactions: [{ type: 'approval', requestId: 'a1', outcome: 'rejected' }],
      });
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, ['run']);
  const events = stdout.text().trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ['turn.end']);
  assert.equal(events[0].ok, true);
  assert.equal(events[0].sessionId, 's1');
  assert.equal(events[0].text, 'done');
  assert.equal(events[0].error, null);
  assert.equal(stderr.text(), '');
});

test('--jsonl emits progress callbacks before the final turn event', async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await runExecCommand({}, { exec: true, jsonl: true }, {
    prompt: 'work',
    stdout: stdout.stream,
    stderr: stderr.stream,
    runner: async (_client, options) => {
      options.onSession('s1', { cwd: '/work' });
      options.onToolCall({ sessionId: 's1', callId: 'c1', name: 'bash' });
      options.onInteraction({
        sessionId: 's1',
        type: 'approval',
        requestId: 'a1',
        tool: 'bash',
        callId: 'c1',
        reason: 'why',
        outcome: 'rejected',
        decision: 'non-interactive exec mode',
      });
      return baseResult();
    },
  });
  assert.equal(code, 0);
  const events = stdout.text().trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ['session.started', 'tool.call', 'interaction', 'turn.end']);
  assert.deepEqual(events[0], { type: 'session.started', sessionId: 's1', cwd: '/work' });
  assert.deepEqual(events[1], { type: 'tool.call', sessionId: 's1', callId: 'c1', name: 'bash' });
  assert.equal(events[2].type, 'interaction');
  assert.equal(events[2].kind, 'approval');
  assert.equal(events[2].outcome, 'rejected');
  assert.equal(events[3].type, 'turn.end');
  assert.equal(stderr.text(), '');
});

test('--jsonl reports a thrown error with the resumable session id', async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await runExecCommand({}, { exec: true, jsonl: true }, {
    prompt: 'work',
    stdout: stdout.stream,
    stderr: stderr.stream,
    runner: async () => {
      throw Object.assign(new Error('exec timed out after 1s'), {
        code: 'attach/exec-timeout',
        sessionId: 's1',
      });
    },
  });
  assert.equal(code, 124);
  const event = JSON.parse(stdout.text().trim());
  assert.equal(event.type, 'error');
  assert.equal(event.ok, false);
  assert.equal(event.sessionId, 's1');
  assert.equal(event.error.code, 'attach/exec-timeout');
  assert.equal(stderr.text(), '');
});

test('--exec --json errors include sessionId null when no session opened', async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await runExecCommand({}, { exec: true, json: true }, {
    prompt: 'work',
    stdout: stdout.stream,
    stderr: stderr.stream,
    runner: async () => {
      throw Object.assign(new Error('not connected'), { code: 'attach/closed' });
    },
  });
  assert.equal(code, 1);
  const value = JSON.parse(stdout.text().trim());
  assert.equal(value.ok, false);
  assert.equal(value.sessionId, null);
  assert.equal(value.error.message, 'not connected');
  assert.equal(stderr.text(), '');
});

test('non-JSON exec errors print a resumable session hint on stderr', async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await runExecCommand({}, { exec: true }, {
    prompt: 'work',
    stdout: stdout.stream,
    stderr: stderr.stream,
    runner: async () => {
      throw Object.assign(new Error('exec interrupted'), {
        code: 'attach/exec-interrupted',
        sessionId: 's1',
      });
    },
  });
  assert.equal(code, 130);
  assert.equal(stdout.text(), '');
  assert.match(stderr.text(), /exec interrupted/u);
  assert.match(stderr.text(), /session s1/u);
});

test('non-JSON exec prints the session id as soon as the session opens', async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await runExecCommand({}, { exec: true }, {
    prompt: 'work',
    stdout: stdout.stream,
    stderr: stderr.stream,
    runner: async (_client, options) => {
      options.onSession('s1', { cwd: '/work' });
      return baseResult();
    },
  });
  assert.equal(code, 0);
  assert.equal(stdout.text(), 'done\n');
  assert.match(stderr.text(), /^dsh-attach: session s1\n$/u);
});

test('--output writes the final text and creates parent directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-output-'));
  try {
    const path = join(dir, 'nested', 'answer.txt');
    const stdout = capture();
    const stderr = capture();
    const code = await runExecCommand({}, { exec: true, output: path }, {
      prompt: 'work',
      stdout: stdout.stream,
      stderr: stderr.stream,
      runner: async () => baseResult({ text: 'saved answer\n' }),
    });
    assert.equal(code, 0);
    assert.equal(await readFile(path, 'utf8'), 'saved answer\n');
    assert.equal(stdout.text(), 'saved answer\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--output writes nothing for an empty final text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-output-'));
  try {
    const path = join(dir, 'answer.txt');
    const code = await runExecCommand({}, { exec: true, output: path }, {
      prompt: 'work',
      stdout: capture().stream,
      stderr: capture().stream,
      runner: async () => baseResult({ ok: false, text: '', reason: 'error' }),
    });
    assert.equal(code, 1);
    await assert.rejects(readFile(path, 'utf8'), /ENOENT/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parses remote SSH flags', () => {
  const options = parseArgs([
    '--ssh', ' user@example.com ',
    '--remote-bin', ' ~/bin/dsh-attach ',
    '--ssh-opt', '-o',
    '--ssh-opt', 'StrictHostKeyChecking=accept-new',
  ]);
  assert.equal(options.ssh, ' user@example.com ');
  assert.equal(options.remoteBin, ' ~/bin/dsh-attach ');
  assert.deepEqual(options.sshOpts, ['-o', 'StrictHostKeyChecking=accept-new']);
  const normalized = normalizeOptions(options);
  assert.equal(normalized.ssh, 'user@example.com');
  assert.equal(normalized.remoteBin, '~/bin/dsh-attach');
  assert.deepEqual(normalized.sshOpts, ['-o', 'StrictHostKeyChecking=accept-new']);
});

test('validates remote SSH flag combinations', () => {
  usageError(['--ssh'], /--ssh needs a value|requires a value/u);
  usageError(['--ssh', '  '], /--ssh needs a target/u);
  usageError(['--ssh', 'host', '--socket', '/tmp/a'], /--ssh cannot be combined with --socket/u);
  usageError(['--ssh', 'host', '--hot'], /--ssh cannot be combined with --hot/u);
  usageError(['--remote-bin', '/opt/dsh-attach'], /--remote-bin requires --ssh/u);
  usageError(['--ssh', 'host', '--remote-bin', '  '], /--remote-bin needs/u);
  usageError(['--ssh-opt', '-o'], /--ssh-opt requires --ssh/u);
  usageError(['--ssh', 'host', '--ssh-opt', '  '], /--ssh-opt needs/u);
});

test('keeps remote paths unexpanded under --ssh', () => {
  const remote = parsed([
    '--ssh', 'host',
    '--exec', '-p', 'work',
    '-C', '~/remote/work',
    '--allow-dir', '~/remote/shared',
    '--cache-root', '~/remote/cache',
    '--output', '~/local-answer.txt',
  ]);
  assert.equal(remote.cwd, '~/remote/work');
  assert.deepEqual(remote.allowDirs, ['~/remote/shared']);
  assert.equal(remote.cacheRoot, '~/remote/cache');
  assert.equal(remote.output.startsWith('~'), false, 'local output paths still expand');

  assert.equal(parsed(['--ssh', 'host', '--exec', '-p', 'x', '--cache-root', '@session']).cacheRoot, '@session');
  assert.equal(parsed(['--ssh', 'host', '--exec', '-p', 'x', '--cache-root', 'relative/cache']).cacheRoot, 'relative/cache');

  const local = parsed(['--exec', '-p', 'work', '-C', '~/local/work', '--allow-dir', '~/local/shared']);
  assert.equal(local.cwd.startsWith('~'), false);
  assert.equal(local.allowDirs[0].startsWith('~'), false);
});

test('rejects --cache-root @cwd under --ssh with an actionable hint', () => {
  assert.throws(
    () => parsed(['--ssh', 'host', '--exec', '-p', 'x', '--cache-root', '@cwd']),
    (error) => /--cache-root @cwd is unavailable with --ssh/u.test(error.message)
      && /@session/u.test(error.message)
      && /explicit remote path/u.test(error.message),
  );
  // @cwd remains valid locally.
  assert.equal(parsed(['--exec', '-p', 'x', '--cache-root', '@cwd']).cacheRoot.endsWith('.cache'), true);
});

test('parses --stdio-proxy and validates its combinations', () => {
  const options = parsed(['--stdio-proxy', '--endpoint', '~/endpoint.json', '--profile', 'desktop']);
  assert.equal(options.stdioProxy, true);
  assert.equal(options.profile, 'desktop');
  assert.equal(options.endpoint.startsWith('~'), false, 'the proxy expands its own local paths');

  usageError(['--stdio-proxy', '--exec', '-p', 'x'], /--stdio-proxy cannot be combined with --exec/u);
  usageError(['--stdio-proxy', '--list'], /--stdio-proxy cannot be combined with --list/u);
  usageError(['--stdio-proxy', '--preview', 's1'], /--stdio-proxy cannot be combined with --preview/u);
  usageError(['--stdio-proxy', '--hot'], /--stdio-proxy cannot be combined with --hot/u);
  usageError(['--stdio-proxy', '--ssh', 'host'], /--stdio-proxy cannot be combined with --ssh/u);
  usageError(['--stdio-proxy', '--socket', '/tmp/a'], /--stdio-proxy with --socket needs --token/u);
});
