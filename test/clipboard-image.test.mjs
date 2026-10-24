import assert from 'node:assert/strict';
import test from 'node:test';

import { readClipboardImage } from '../lib/client/clipboard-image.js';

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

test('reports an empty clipboard clearly', async () => {
  await assert.rejects(
    readClipboardImage({ platform: 'darwin', run: async () => ({ stdout: '' }) }),
    /clipboard|image/i,
  );
});
