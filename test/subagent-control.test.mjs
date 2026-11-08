import assert from 'node:assert/strict';
import test from 'node:test';

import { stripTerminalSequences } from '@earendil-works/pi-tui';

import { ConfirmPanel, TextPromptPanel } from '../lib/client/panels.js';
import {
  subagentControlCapabilities,
  subagentControlErrorText,
  subagentControlHint,
  subagentControlUnavailable,
} from '../lib/client/subagent-control.js';
import {
  controlSubagentRow,
  findSubagentRow,
  subagentControlCapabilities as hostControlCapabilities,
} from '../lib/host/subagent-control.js';

test('detects host control methods without assuming one runtime generation', () => {
  assert.deepEqual(hostControlCapabilities({
    listDescendants() {},
    prompt() {},
    interruptByParent() {},
  }), {
    continue: true,
    interrupt: true,
  });
  assert.deepEqual(hostControlCapabilities({
    listDescendants() {},
    sendMessage() {},
    interrupt() {},
  }), {
    continue: true,
    interrupt: true,
  });
  assert.deepEqual(hostControlCapabilities({ prompt() {}, interruptByParent() {} }), {
    continue: false,
    interrupt: false,
  });
  assert.deepEqual(hostControlCapabilities({ listDescendants() {} }), {
    continue: false,
    interrupt: false,
  });
  assert.deepEqual(hostControlCapabilities(undefined), { continue: false, interrupt: false });
});

test('finds only child rows by durable id', () => {
  const rows = [
    { kind: 'diagnostic', id: 'bad', parentId: 'root', reason: 'corrupt' },
    { kind: 'child', id: 'child-1', parentId: 'root', mode: 'continuable', activity: 'running' },
    { kind: 'child', id: 'child-2', parentId: 'root', mode: 'one-shot', activity: 'inactive' },
  ];
  assert.equal(findSubagentRow(rows, 'child-1')?.id, 'child-1');
  assert.equal(findSubagentRow(rows, 'bad'), null);
  assert.equal(findSubagentRow(rows, 'missing'), null);
});

test('annotates rows with continue and interrupt availability', () => {
  const control = { continue: true, interrupt: true };
  const continuable = controlSubagentRow(
    { id: 'c1', parentId: 'p', depth: 1, mode: 'continuable', activity: 'running', label: null },
    control,
    true,
  );
  assert.equal(continuable.canContinue, true);
  assert.equal(continuable.canInterrupt, true);
  assert.equal(continuable.parentActive, true);

  const orphan = controlSubagentRow(
    { id: 'c2', parentId: 'gone', depth: 1, mode: 'continuable', activity: 'inactive', label: null },
    control,
    false,
  );
  assert.equal(orphan.parentActive, false);
  assert.equal(orphan.canContinue, false);
  assert.equal(orphan.canInterrupt, false);

  const oneShot = controlSubagentRow(
    { id: 'c3', parentId: 'p', depth: 1, mode: 'one-shot', activity: 'running', label: null },
    { continue: false, interrupt: true },
    true,
  );
  assert.equal(oneShot.canContinue, false);
  assert.equal(oneShot.canInterrupt, true);
});

test('reads advertised control capabilities from the host descriptor', () => {
  assert.deepEqual(subagentControlCapabilities({
    capabilities: ['subagent.children', 'subagent.continue', 'subagent.interrupt'],
  }), { continue: true, interrupt: true });
  assert.deepEqual(subagentControlCapabilities({ capabilities: ['subagent.children'] }), {
    continue: false,
    interrupt: false,
  });
  assert.deepEqual(subagentControlCapabilities(null), { continue: false, interrupt: false });
});

test('translates control failures and explains unavailable actions', () => {
  assert.match(
    subagentControlErrorText({ code: 'subagent/parent-unavailable', message: 'wire wording' }),
    /parent is not live/,
  );
  assert.equal(
    subagentControlErrorText({ code: 'subagent/not-resumable' }),
    'only continuable subagents can be continued',
  );
  assert.equal(
    subagentControlErrorText(new Error('boom'), 'continue'),
    'continue failed: boom',
  );

  const host = { continue: true, interrupt: true };
  assert.equal(subagentControlUnavailable({ canContinue: true }, 'continue', host), null);
  assert.match(
    subagentControlUnavailable({ mode: 'one-shot', canContinue: false }, 'continue', host),
    /only continuable/,
  );
  assert.match(
    subagentControlUnavailable({ mode: 'continuable', canContinue: false, parentActive: false }, 'continue', host),
    /parent is not live/,
  );
  assert.match(
    subagentControlUnavailable({ mode: 'continuable', canContinue: false, parentActive: true, running: true }, 'continue', { continue: false }),
    /does not expose subagent continuation/,
  );
  assert.match(
    subagentControlUnavailable({ mode: 'unknown', canContinue: false }, 'continue', { continue: false }),
    /does not expose subagent continuation/,
  );
  assert.equal(subagentControlUnavailable({ canInterrupt: true, running: true }, 'interrupt', host), null);
  assert.match(
    subagentControlUnavailable({ canInterrupt: false, running: true }, 'interrupt', { interrupt: false }),
    /does not expose subagent interruption/,
  );
  assert.match(
    subagentControlUnavailable({ canInterrupt: false, running: false }, 'interrupt', { interrupt: false }),
    /does not expose subagent interruption/,
  );
  assert.match(subagentControlUnavailable({ canInterrupt: false, running: false }, 'interrupt', host), /not running/);
});

test('summarizes the picker action hint', () => {
  assert.equal(subagentControlHint([
    { canContinue: true, canInterrupt: true },
    { canContinue: false, canInterrupt: false },
  ]), 'c continue · x stop');
  assert.equal(subagentControlHint([{ canContinue: false, canInterrupt: true }]), 'x stop');
  assert.equal(subagentControlHint([]), '');
});

test('confirmation requires an explicit yes and cancels on no or escape', () => {
  const events = [];
  const panel = new ConfirmPanel('Stop subagent', ['Stop Reviewer?'], {
    confirmLabel: 'stop',
    onConfirm: () => events.push('confirm'),
    onCancel: () => events.push('cancel'),
  });
  panel.handleInput('n');
  panel.handleInput('\x1b');
  assert.deepEqual(events, ['cancel', 'cancel']);
  panel.handleInput('\r');
  panel.handleInput('y');
  assert.deepEqual(events, ['cancel', 'cancel', 'cancel', 'confirm']);
  const text = stripTerminalSequences(panel.render(60).join('\n'));
  assert.match(text, /Stop Reviewer\?/);
  assert.match(text, /\[y\] stop/);
});

test('the follow-up prompt uses action-specific wording', () => {
  const panel = new TextPromptPanel('Continue Reviewer', '', {
    hint: 'follow-up message for the subagent inbox',
    submitVerb: 'send',
    onSubmit() {},
    onCancel() {},
  });
  const text = stripTerminalSequences(panel.render(70).join('\n'));
  assert.match(text, /follow-up message for the subagent inbox/);
  assert.match(text, /enter send · esc cancel/);
  assert.doesNotMatch(text, /edit the queued message/);
});
