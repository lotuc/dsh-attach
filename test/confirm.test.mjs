import assert from 'node:assert/strict';
import test from 'node:test';

import { stripTerminalSequences } from '@earendil-works/pi-tui';

import { ConfirmPanel } from '../lib/client/panels.js';

function panel() {
  const calls = [];
  const value = new ConfirmPanel('Complete goal?', ['Mark the goal complete?'], {
    onConfirm: () => calls.push('confirm'),
    onCancel: () => calls.push('cancel'),
  });
  return { calls, value };
}

test('confirms destructive actions only on an explicit y', () => {
  for (const key of ['y', 'Y']) {
    const { calls, value } = panel();
    value.handleInput(key);
    assert.deepEqual(calls, ['confirm'], key);
  }
  const { value } = panel();
  const rendered = stripTerminalSequences(value.render(70).join('\n'));
  assert.match(rendered, /Mark the goal complete\?/u);
  assert.match(rendered, /\[y\] confirm/u);
  assert.match(rendered, /enter cancels/u);
});

test('cancels on enter, n and escape', () => {
  for (const key of ['\r', '\n', 'n', 'N', '\x1b']) {
    const { calls, value } = panel();
    value.handleInput(key);
    assert.deepEqual(calls, ['cancel'], JSON.stringify(key));
  }
});
