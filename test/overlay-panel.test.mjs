import assert from 'node:assert/strict';
import test from 'node:test';

import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';

import { copyToClipboard } from '../lib/client/clipboard.js';
import { InfoPanel } from '../lib/client/panels.js';

test('copies through the platform clipboard command', () => {
  const calls = [];
  const ok = copyToClipboard('hello', {
    platform: 'darwin',
    spawnSync: (command, args, options) => {
      calls.push([command, args, options.input]);
      return { status: 0 };
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [['pbcopy', [], 'hello']]);
  assert.equal(copyToClipboard('', { platform: 'darwin', spawnSync: () => ({ status: 0 }) }), false);
});

test('scrolls and maximizes the shared info panel', () => {
  const fullscreen = [];
  const lines = Array.from({ length: 80 }, (_, index) => `line ${index} with enough text to wrap in a narrow panel`);
  const panel = new InfoPanel('Info', lines, () => {}, {
    onToggleFullscreen: (value) => fullscreen.push(value),
  });
  const first = panel.render(40).join('\n');
  assert.match(first, /line 0/);
  assert.ok(panel.maxScroll > 0);
  const before = panel.scroll;
  panel.handleInput('\x1b[6~');
  assert.ok(panel.scroll > before);
  panel.handleInput('F');
  assert.deepEqual(fullscreen, [true]);
  assert.equal(panel.fullscreen, true);
});

test('fullscreen panels drop the left and right frame borders', () => {
  const panel = new InfoPanel('Info', ['hello'], () => {});
  const windowed = stripTerminalSequences(panel.render(40).join('\n')).split('\n');
  assert.match(windowed[1], /^│/u);

  panel.handleInput('F');
  const rows = stripTerminalSequences(panel.render(40).join('\n')).split('\n');
  assert.ok(rows.every((row) => !row.includes('│')));
  assert.match(rows[0], /^─ Info ─/u);
  assert.match(rows.at(-1), /^─+$/u);
  assert.ok(rows.every((row) => visibleWidth(row) === 40));
});
