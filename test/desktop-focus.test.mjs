import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDesktopFocusScript, focusDesktopSession } from '../lib/client/desktop-focus.js';

test('builds a search-and-open AppleScript without interpolating the title', () => {
  const script = buildDesktopFocusScript();
  assert.match(script, /keystroke "k" using command down/u);
  assert.match(script, /keystroke \(item 1 of argv\)/u);
  assert.match(script, /key code 36/u);
  assert.doesNotMatch(script, /Fix tests/u);
});

test('opens DSH and searches for the current title on macOS', () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = focusDesktopSession({ title: 'Fix tests', platform: 'darwin', spawnSync: run });
  assert.deepEqual(result, { ok: true, selected: true });
  assert.equal(calls[0][0], 'open');
  assert.deepEqual(calls[0][1], ['dsh://open']);
  assert.equal(calls[1][0], 'osascript');
  assert.equal(calls[1][1].at(-1), 'Fix tests');
});

test('falls back to the session id and reports non-macOS support', () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.equal(focusDesktopSession({ title: ' ', sessionId: 's1', platform: 'darwin', spawnSync: run }).ok, true);
  assert.equal(calls[1][1].at(-1), 's1');
  assert.deepEqual(focusDesktopSession({ title: 'x', platform: 'linux' }), {
    ok: false,
    selected: false,
    reason: 'desktop focus is not implemented on linux',
  });
});

test('explains missing Accessibility permission', () => {
  const run = (_command, args) => (args[0] === 'dsh://open'
    ? { status: 0, stdout: '', stderr: '' }
    : { status: 1, stdout: '', stderr: 'osascript is not allowed assistive access' });
  const result = focusDesktopSession({ title: 'Fix tests', platform: 'darwin', spawnSync: run });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Accessibility permission/u);
});
