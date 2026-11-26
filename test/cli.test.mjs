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
  runRemoteCommand,
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

async function runRemote(args, env) {
  const stdout = capture();
  const stderr = capture();
  const code = await runRemoteCommand(args, {
    env,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

test('remote add/list/show/remove manage a remotes.toml lifecycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-remotes-cli-'));
  const path = join(dir, 'remotes.toml');
  const env = { DSH_ATTACH_REMOTES: path, DSH_HOME: dir };
  try {
    const added = await runRemote([
      'add', 'win',
      '--ssh', 'user@localhost',
      '--ssh-opt', '-p2233',
      '--remote-bin', 'C:/Users/me/AppData/Roaming/npm/dsh-attach.cmd',
      '--profile', 'desktop',
      '--endpoint', '/remote/endpoint.json',
      '--cache-root', '@session',
    ], env);
    assert.equal(added.code, 0);
    assert.match(added.out, /Added remote alias "win"/u);
    const text = await readFile(path, 'utf8');
    assert.match(text, /ssh = "user@localhost"/u);
    assert.match(text, /ssh_opts = \[ "-p2233" \]/u);
    assert.match(text, /remote_bin = /u);
    assert.match(text, /cache_root = "@session"/u);

    const listed = await runRemote(['list'], env);
    assert.equal(listed.code, 0);
    assert.match(listed.out, /NAME/u);
    assert.match(listed.out, /win/u);
    assert.match(listed.out, /user@localhost/u);
    assert.match(listed.out, /desktop/u);

    const jsonList = await runRemote(['list', '--json'], env);
    assert.equal(jsonList.code, 0);
    const parsedList = JSON.parse(jsonList.out);
    assert.equal(parsedList.remotes.win.ssh, 'user@localhost');
    assert.deepEqual(parsedList.remotes.win.sshOpts, ['-p2233']);
    assert.equal(parsedList.remotes.win.remoteBin, 'C:/Users/me/AppData/Roaming/npm/dsh-attach.cmd');
    assert.equal(parsedList.remotes.win.cacheRoot, '@session');

    const shown = await runRemote(['show', 'win'], env);
    assert.equal(shown.code, 0);
    assert.match(shown.out, /name\s+win/u);
    assert.match(shown.out, /user@localhost/u);
    assert.match(shown.out, /@session/u);

    const shownJson = await runRemote(['show', 'win', '--json'], env);
    assert.equal(shownJson.code, 0);
    const parsedShow = JSON.parse(shownJson.out);
    assert.equal(parsedShow.name, 'win');
    assert.equal(parsedShow.ssh, 'user@localhost');
    assert.deepEqual(parsedShow.sshOpts, ['-p2233']);
    assert.equal(parsedShow.endpoint, '/remote/endpoint.json');

    const duplicate = await runRemote(['add', 'win', '--ssh', 'other@host'], env);
    assert.equal(duplicate.code, 1);
    assert.match(duplicate.err, /already exists/u);
    assert.match(duplicate.err, /--force/u);

    const forced = await runRemote(['add', 'win', '--ssh', 'other@host', '--force'], env);
    assert.equal(forced.code, 0);
    assert.match(await readFile(path, 'utf8'), /ssh = "other@host"/u);

    const removed = await runRemote(['remove', 'win'], env);
    assert.equal(removed.code, 0);
    assert.match(removed.out, /Removed remote alias "win"/u);
    const listedAfter = await runRemote(['list'], env);
    assert.match(listedAfter.out, /No remote aliases configured/u);

    const missing = await runRemote(['remove', 'win'], env);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /not configured/u);

    assert.equal((await runRemote(['add', 'rmtest', '--ssh', 'host'], env)).code, 0);
    assert.equal((await runRemote(['rm', 'rmtest'], env)).code, 0);
    assert.match((await runRemote(['list'], env)).out, /No remote aliases configured/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('remote add validates names and options', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-remotes-cli-'));
  const path = join(dir, 'remotes.toml');
  const env = { DSH_ATTACH_REMOTES: path, DSH_HOME: dir };
  try {
    assert.equal((await runRemote(['add', 'bad name', '--ssh', 'host'], env)).code, 2);
    assert.match((await runRemote(['add', '-bad', '--ssh', 'host'], env)).err, /unknown option|invalid remote alias/u);
    assert.match((await runRemote(['add', 'x'], env)).err, /--ssh/u);
    assert.match((await runRemote(['add', 'x', '--ssh', '  '], env)).err, /--ssh/u);
    assert.match(
      (await runRemote(['add', 'x', '--ssh', 'host', '--cache-root', '@cwd'], env)).err,
      /@cwd.*@session|use @session/u,
    );
    assert.match((await runRemote(['add', 'x', '--ssh', 'host', '--json'], env)).err, /does not accept --json/u);
    assert.equal((await runRemote(['list', 'extra'], env)).code, 2);
    assert.equal((await runRemote(['show'], env)).code, 2);
    assert.equal((await runRemote(['remove'], env)).code, 2);
    assert.equal((await runRemote(['nope'], env)).code, 2);
    assert.match((await runRemote(['show', 'missing'], env)).err, /not configured/u);

    const help = await runRemote(['--help'], env);
    assert.equal(help.code, 0);
    assert.match(help.out, /dsh-attach remote/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--remote and --ssh aliases merge CLI overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-remotes-cli-'));
  const path = join(dir, 'remotes.toml');
  const env = { DSH_ATTACH_REMOTES: path, DSH_HOME: dir };
  try {
    await runRemote([
      'add', 'win',
      '--ssh', 'user@localhost',
      '--ssh-opt', '-p2233',
      '--remote-bin', 'C:/bin/dsh-attach.cmd',
      '--profile', 'desktop',
      '--endpoint', '/remote/endpoint.json',
      '--cache-root', '@session',
    ], env);

    const viaRemote = normalizeOptions(parseArgs([
      '--remote', 'win',
      '--exec', '-p', 'work',
      '--profile', 'cli-profile',
      '--remote-bin', 'cli-bin',
      '--ssh-opt', '-v',
      '-C', '/remote/work',
    ]), env);
    assert.equal(viaRemote.ssh, 'user@localhost');
    assert.equal(viaRemote.remoteAlias, 'win');
    assert.deepEqual(viaRemote.sshOpts, ['-p2233', '-v']);
    assert.equal(viaRemote.profile, 'cli-profile');
    assert.equal(viaRemote.remoteBin, 'cli-bin');
    assert.equal(viaRemote.endpoint, '/remote/endpoint.json');
    assert.equal(viaRemote.cacheRoot, '@session');
    assert.equal(viaRemote.cwd, '/remote/work', 'remote cwd is not expanded');

    const viaSsh = normalizeOptions(parseArgs([
      '--ssh', 'win',
      '--exec', '-p', 'work',
      '--endpoint', '/other/endpoint.json',
    ]), env);
    assert.equal(viaSsh.ssh, 'user@localhost');
    assert.equal(viaSsh.remoteAlias, 'win');
    assert.deepEqual(viaSsh.sshOpts, ['-p2233']);
    assert.equal(viaSsh.remoteBin, 'C:/bin/dsh-attach.cmd');
    assert.equal(viaSsh.profile, 'desktop');
    assert.equal(viaSsh.endpoint, '/other/endpoint.json');

    const literal = normalizeOptions(parseArgs(['--ssh', 'literal-host']), env);
    assert.equal(literal.ssh, 'literal-host');
    assert.equal(literal.remoteAlias, undefined);

    assert.throws(
      () => normalizeOptions(parseArgs(['--remote', 'missing']), env),
      (error) => /unknown remote alias "missing"/u.test(error.message)
        && /configured aliases: win/u.test(error.message)
        && /remote add missing/u.test(error.message),
    );
    usageErrorForEnv(['--remote', 'win', '--ssh', 'host'], env, /--remote cannot be combined with --ssh/u);
    usageErrorForEnv(['--remote', 'win', '--socket', '/tmp/sock'], env, /--remote cannot be combined with --socket/u);
    usageErrorForEnv(['--remote', 'win', '--hot'], env, /--remote cannot be combined with --hot/u);
    usageErrorForEnv(['--remote', 'win', '--stdio-proxy'], env, /--remote cannot be combined with --stdio-proxy/u);
    usageErrorForEnv(['--remote', '  '], env, /--remote needs an alias name/u);
    usageErrorForEnv(
      ['--remote', 'win', '--exec', '-p', 'x', '--cache-root', '@cwd'],
      env,
      /--cache-root @cwd is unavailable/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function usageErrorForEnv(argv, env, pattern) {
  assert.throws(
    () => normalizeOptions(parseArgs(argv), env),
    (error) => pattern.test(error.message),
    `expected ${argv.join(' ')} to fail`,
  );
}

test('remote alias resume hints stay concise', async () => {
  const { resumeArgv } = await import('../lib/client/app.js');
  assert.deepEqual(
    resumeArgv({
      remoteAlias: 'win',
      ssh: 'user@localhost',
      sshOpts: ['-p2233'],
      remoteBin: 'C:/bin/dsh-attach.cmd',
      profile: 'desktop',
      endpoint: '/remote/endpoint.json',
      theme: 'light',
    }, 's1'),
    ['dsh-attach', '--remote', 'win', '--reattach', 's1'],
  );
  assert.deepEqual(
    resumeArgv({
      ssh: 'user@localhost',
      sshOpts: ['-p2233'],
      remoteBin: 'C:/bin/dsh-attach.cmd',
      profile: 'desktop',
      endpoint: '/remote/endpoint.json',
    }, 's1'),
    [
      'dsh-attach', '--ssh', 'user@localhost', '--remote-bin', 'C:/bin/dsh-attach.cmd',
      '--ssh-opt', '-p2233', '--profile', 'desktop', '--endpoint', '/remote/endpoint.json',
      '--reattach', 's1',
    ],
  );
});
