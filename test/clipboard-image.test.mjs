import assert from 'node:assert/strict';
import test from 'node:test';

import { readClipboardImage, readClipboardText } from '../lib/client/clipboard-image.js';

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
