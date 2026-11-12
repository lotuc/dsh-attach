import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { readClipboardImage, readClipboardText, writeClipboardText } from '../lib/client/clipboard-image.js';

test('reads a PNG from pngpaste on macOS', async () => {
  const calls = [];
  const image = await readClipboardImage({
    platform: 'darwin',
    run: async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: 'YWJj\n' };
    },
  });
  assert.deepEqual(calls, [['pngpaste', '-b']]);
  assert.equal(image.mediaType, 'image/png');
  assert.equal(image.data, 'YWJj');
});

test('falls back to wl-paste on Linux', async () => {
  const image = await readClipboardImage({
    platform: 'linux',
    run: async (command) => {
      if (command === 'wl-paste') return { stdout: Buffer.from('png') };
      throw new Error('not installed');
    },
  });
  assert.equal(image.data, Buffer.from('png').toString('base64'));
});

test('reads a PNG from the Windows clipboard through PowerShell', async () => {
  const calls = [];
  const image = await readClipboardImage({
    platform: 'win32',
    run: async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: 'YWJj\n' };
    },
  });
  assert.equal(calls[0][0], 'powershell.exe');
  assert.ok(calls[0].includes('-STA'));
  assert.equal(image.mediaType, 'image/png');
  assert.equal(image.data, 'YWJj');
});

test('reports an empty clipboard clearly', async () => {
  await assert.rejects(
    readClipboardImage({ platform: 'darwin', run: async () => ({ stdout: '' }) }),
    /clipboard|image/i,
  );
});

test('reads clipboard text on macOS and Windows', async () => {
  assert.equal(await readClipboardText({
    platform: 'darwin',
    run: async () => ({ stdout: 'hello' }),
  }), 'hello');
  assert.equal(await readClipboardText({
    platform: 'win32',
    run: async (command) => {
      assert.equal(command, 'powershell.exe');
      return { stdout: 'hello windows' };
    },
  }), 'hello windows');
});

test('falls back to xclip text on Linux and returns empty when unavailable', async () => {
  assert.equal(await readClipboardText({
    platform: 'linux',
    run: async (command) => {
      if (command === 'xclip') return { stdout: 'hello linux' };
      throw new Error('not installed');
    },
  }), 'hello linux');
  assert.equal(await readClipboardText({
    platform: 'linux',
    run: async () => { throw new Error('not installed'); },
  }), '');
});


function fakeSpawn(commands, { fail = false, code = 0 } = {}) {
  return (command) => {
    const child = new EventEmitter();
    child.stdin = { end(value) { commands.push([command, value]); } };
    queueMicrotask(() => {
      if (fail) child.emit('error', new Error('not installed'));
      else child.emit('close', code);
    });
    return child;
  };
}

test('writes clipboard text through the platform command', async () => {
  const commands = [];
  assert.equal(await writeClipboardText('hello', { platform: 'darwin', spawnFn: fakeSpawn(commands) }), true);
  assert.deepEqual(commands, [['pbcopy', 'hello']]);
  await assert.rejects(writeClipboardText('', { platform: 'darwin', spawnFn: fakeSpawn([]) }), /nothing/u);
});

test('falls back through Linux clipboard writers and reports failure', async () => {
  const commands = [];
  let first = true;
  const spawnFn = (command) => {
    if (first && command === 'wl-copy') {
      first = false;
      return fakeSpawn(commands, { fail: true })(command);
    }
    return fakeSpawn(commands)(command);
  };
  assert.equal(await writeClipboardText('hello', { platform: 'linux', spawnFn }), true);
  assert.deepEqual(commands.at(-1), ['xclip', 'hello']);
  assert.equal(commands.some(([command]) => command === 'wl-copy'), true);
  await assert.rejects(
    writeClipboardText('hello', { platform: 'linux', spawnFn: fakeSpawn([], { fail: true }) }),
    /unavailable/u,
  );
});
