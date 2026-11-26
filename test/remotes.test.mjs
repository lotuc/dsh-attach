import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadRemotes,
  loadRemotesSync,
  mergeRemoteOptions,
  parseRemotesText,
  resolveRemoteAlias,
  resolveRemotesPath,
  saveRemotes,
} from '../lib/client/remotes.js';

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-attach-remotes-'));
}

test('resolveRemotesPath follows DSH_HOME and DSH_ATTACH_REMOTES', () => {
  assert.equal(
    resolveRemotesPath({ DSH_HOME: '/tmp/dsh-home' }),
    join('/tmp/dsh-home', 'dsh-attach', 'remotes.toml'),
  );
  assert.equal(
    resolveRemotesPath({ DSH_HOME: '/tmp/dsh-home', DSH_ATTACH_REMOTES: '/tmp/custom.toml' }),
    '/tmp/custom.toml',
  );
  assert.equal(
    resolveRemotesPath({ DSH_HOME: '/tmp/dsh-home', DSH_ATTACH_REMOTES: '  ' }),
    join('/tmp/dsh-home', 'dsh-attach', 'remotes.toml'),
  );
});

test('loadRemotes returns an empty map for a missing file', async () => {
  const dir = await tempDir();
  try {
    assert.deepEqual(await loadRemotes(join(dir, 'missing.toml')), {});
    assert.deepEqual(loadRemotesSync(join(dir, 'missing.toml')), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadRemotes normalizes snake_case and camelCase entries', async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, 'remotes.toml');
    await writeFile(path, [
      '[remotes.win]',
      'ssh = "user@localhost"',
      'ssh_opts = ["-p", "2233"]',
      'remote_bin = "C:/bin/dsh-attach.cmd"',
      'profile = "desktop"',
      'cache_root = "@session"',
      '',
      '[remotes.build]',
      'ssh = "build-box"',
      'sshOpts = ["-v"]',
      'remoteBin = "/usr/local/bin/dsh-attach"',
      'endpoint = "/remote/endpoint.json"',
      '',
    ].join('\n'));

    const remotes = await loadRemotes(path);
    assert.deepEqual(remotes.win, {
      ssh: 'user@localhost',
      sshOpts: ['-p', '2233'],
      remoteBin: 'C:/bin/dsh-attach.cmd',
      profile: 'desktop',
      cacheRoot: '@session',
    });
    assert.deepEqual(remotes.build, {
      ssh: 'build-box',
      sshOpts: ['-v'],
      remoteBin: '/usr/local/bin/dsh-attach',
      endpoint: '/remote/endpoint.json',
    });
    assert.deepEqual(loadRemotesSync(path), remotes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadRemotes reports malformed TOML as attach/remotes-config', async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, 'remotes.toml');
    await writeFile(path, '[remotes.win\nssh = "x"\n');
    await assert.rejects(loadRemotes(path), (error) => (
      error.code === 'attach/remotes-config' && error.message.includes(path)
    ));
    assert.throws(() => loadRemotesSync(path), (error) => error.code === 'attach/remotes-config');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseRemotesText validates alias names and fields', () => {
  assert.throws(
    () => parseRemotesText('[remotes."bad name"]\nssh = "host"\n'),
    (error) => error.code === 'attach/remotes-config' && /invalid alias name/u.test(error.message),
  );
  assert.throws(
    () => parseRemotesText('[remotes.win]\nssh = ""\n'),
    (error) => error.code === 'attach/remotes-config' && /non-empty ssh target/u.test(error.message),
  );
  assert.throws(
    () => parseRemotesText('[remotes.win]\nssh = "host"\nssh_opts = "-p"\n'),
    (error) => error.code === 'attach/remotes-config' && /array of strings/u.test(error.message),
  );
  assert.throws(
    () => parseRemotesText('[remotes.win]\nssh = "host"\nssh_opts = [1]\n'),
    (error) => error.code === 'attach/remotes-config' && /array of strings/u.test(error.message),
  );
  assert.throws(
    () => parseRemotesText('remotes = "nope"\n'),
    (error) => error.code === 'attach/remotes-config' && /must be a table/u.test(error.message),
  );
});

test('saveRemotes writes clean snake_case TOML atomically with private modes', async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, 'nested', 'remotes.toml');
    await saveRemotes(path, {
      win: {
        ssh: 'user@localhost',
        sshOpts: ['-p', '2233'],
        remoteBin: 'C:/bin/dsh-attach.cmd',
        profile: 'desktop',
        endpoint: '/remote/endpoint.json',
        cacheRoot: '@session',
      },
      bare: { ssh: 'bare-host' },
    });

    const text = await readFile(path, 'utf8');
    assert.match(text, /\[remotes\.bare\]/u);
    assert.match(text, /\[remotes\.win\]/u);
    assert.match(text, /ssh = "user@localhost"/u);
    assert.match(text, /ssh_opts = \[/u);
    assert.match(text, /remote_bin = "C:\/bin\/dsh-attach\.cmd"/u);
    assert.match(text, /cache_root = "@session"/u);
    assert.doesNotMatch(text, /sshOpts|remoteBin|cacheRoot/u);
    assert.equal((await readFile(path, 'utf8')).endsWith('\n'), true);

    assert.deepEqual((await loadRemotes(path)).win.ssh, 'user@localhost');
    assert.deepEqual(await readdir(join(dir, 'nested')), ['remotes.toml']);

    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(dir, 'nested'))).mode & 0o777, 0o700);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saveRemotes replaces an existing file and rejects invalid input', async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, 'remotes.toml');
    await saveRemotes(path, { win: { ssh: 'first' } });
    await saveRemotes(path, { win: { ssh: 'second' } });
    assert.deepEqual(await loadRemotes(path), { win: { ssh: 'second' } });

    await assert.rejects(
      saveRemotes(path, { 'bad name': { ssh: 'host' } }),
      (error) => error.code === 'attach/remotes-config',
    );
    await assert.rejects(
      saveRemotes(path, { win: { ssh: '' } }),
      (error) => error.code === 'attach/remotes-config',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveRemoteAlias returns a normalized entry or null', async () => {
  const remotes = {
    win: {
      ssh: 'user@localhost',
      ssh_opts: ['-p2233'],
      remote_bin: 'C:/bin/dsh-attach.cmd',
      profile: 'desktop',
    },
  };
  assert.deepEqual(resolveRemoteAlias('win', remotes), {
    name: 'win',
    ssh: 'user@localhost',
    sshOpts: ['-p2233'],
    remoteBin: 'C:/bin/dsh-attach.cmd',
    profile: 'desktop',
    endpoint: undefined,
    cacheRoot: undefined,
  });
  assert.equal(resolveRemoteAlias('missing', remotes), null);
  assert.equal(resolveRemoteAlias('bad name', remotes), null);
  assert.equal(resolveRemoteAlias('win', null), null);
  assert.equal(resolveRemoteAlias('win', { win: { ssh: '' } }), null);
});

test('mergeRemoteOptions gives CLI scalars precedence and appends ssh opts', () => {
  const alias = {
    name: 'win',
    ssh: 'alias-host',
    sshOpts: ['-p', '2233'],
    remoteBin: 'alias-bin',
    profile: 'alias-profile',
    endpoint: 'alias-endpoint',
    cacheRoot: '@session',
  };
  const merged = mergeRemoteOptions(alias, {
    ssh: 'alias-name-is-ignored',
    sshOpts: ['-v'],
    profile: 'cli-profile',
    remoteBin: 'cli-bin',
    cacheRoot: '/cli/cache',
  });
  assert.equal(merged.ssh, 'alias-host');
  assert.deepEqual(merged.sshOpts, ['-p', '2233', '-v']);
  assert.equal(merged.profile, 'cli-profile');
  assert.equal(merged.remoteBin, 'cli-bin');
  assert.equal(merged.endpoint, 'alias-endpoint');
  assert.equal(merged.cacheRoot, '/cli/cache');

  const untouched = mergeRemoteOptions(alias, {});
  assert.deepEqual(untouched.sshOpts, ['-p', '2233']);
  assert.equal(untouched.profile, 'alias-profile');
  assert.equal(untouched.remoteBin, 'alias-bin');
  assert.equal(untouched.endpoint, 'alias-endpoint');
  assert.equal(untouched.cacheRoot, '@session');
});
