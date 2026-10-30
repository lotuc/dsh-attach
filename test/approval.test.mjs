import assert from 'node:assert/strict';
import test from 'node:test';

import { stripTerminalSequences } from '@earendil-works/pi-tui';

import { ApprovalDetailsPanel, ApprovalPanel } from '../lib/client/panels.js';

test('approval details shortcut opens the full request and command', () => {
  const answers = [];
  const sectionsSeen = [];
  const panel = new ApprovalPanel(
    {
      toolName: 'bash',
      displayReason: { en: 'Allow this command?', zh: '允许这个操作吗？' },
      reason: 'fallback',
    },
    'rm -rf /tmp/example',
    (outcome) => answers.push(outcome),
    {
      rawDetail: '{"command":"rm -rf /tmp/example","description":"clean up"}',
      onDetails: () => sectionsSeen.push(...panel.detailsSections()),
    },
  );

  const rendered = stripTerminalSequences(panel.render(80).join('\n'));
  assert.match(rendered, /\[d\] details/);

  panel.handleInput('d');
  assert.deepEqual(sectionsSeen.map((section) => section.label), [
    'Request',
    'Command',
    'Full arguments',
  ]);
  assert.equal(sectionsSeen[0].text, '允许这个操作吗？');
  assert.equal(sectionsSeen[1].text, 'rm -rf /tmp/example');
  assert.match(sectionsSeen[2].text, /description/);
  assert.deepEqual(answers, []);

  panel.handleInput('y');
  assert.deepEqual(answers, ['allowed-once']);
});

test('approval details use the untruncated command from raw arguments', () => {
  const longCommand = `echo ${'x'.repeat(400)}`;
  const panel = new ApprovalPanel(
    { toolName: 'bash' },
    `${longCommand.slice(0, 120)}…`,
    () => {},
    { rawDetail: JSON.stringify({ command: longCommand, description: 'long command' }) },
  );
  const sections = panel.detailsSections();
  assert.equal(sections[1].label, 'Command');
  assert.equal(sections[1].text, longCommand);
  assert.ok(sections[1].text.length > 220);
});

test('approval details scrolls long content and closes with escape', () => {
  const longCommand = Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n');
  let closed = 0;
  let renders = 0;
  const panel = new ApprovalDetailsPanel(
    'Approval · bash',
    [
      { label: 'Request', text: 'Allow this long operation?' },
      { label: 'Command', text: longCommand },
    ],
    {
      onClose: () => {
        closed += 1;
      },
      requestRender: () => {
        renders += 1;
      },
    },
  );

  const first = stripTerminalSequences(panel.render(80).join('\n'));
  assert.match(first, /Request/);
  assert.match(first, /Allow this long operation/);
  assert.match(first, /Command/);
  assert.match(first, /line 0/);
  assert.match(first, /read-only/);
  assert.ok(panel.maxScroll > 0);

  const before = panel.scroll;
  panel.handleInput('\x1b[6~'); // PageDown
  assert.ok(panel.scroll > before);
  assert.ok(renders > 0);

  panel.handleInput('\x1b'); // Escape
  assert.equal(closed, 1);
});

test('approval requires explicit keys and detaches on escape', () => {
  const answers = [];
  let details = 0;
  let detached = 0;
  const panel = new ApprovalPanel(
    { toolName: 'bash' },
    'echo ok',
    (outcome) => answers.push(outcome),
    { onDetails: () => { details += 1; }, onDetach: () => { detached += 1; } },
  );

  panel.handleInput('\r');
  assert.deepEqual(answers, [], 'enter inspects details instead of allowing');
  assert.equal(details, 1);
  panel.handleInput('y');
  assert.deepEqual(answers, ['allowed-once']);
  panel.handleInput('n');
  assert.deepEqual(answers, ['allowed-once', 'rejected']);
  panel.handleInput('\x1b');
  assert.equal(detached, 1);
  assert.deepEqual(answers, ['allowed-once', 'rejected'], 'escape does not answer');
});
