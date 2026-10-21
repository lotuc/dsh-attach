import assert from 'node:assert/strict';
import test from 'node:test';

import { ReasoningRow } from '../lib/client/transcript.js';
import { StepActivity } from '../lib/client/step-activity.js';

function fixture() {
  const added = [];
  const removed = [];
  const steps = new StepActivity({
    addRow: (row) => added.push(row),
    removeRow: (row) => removed.push(row),
    requestRender: () => {},
  });
  return { steps, added, removed };
}

test('groups consecutive tool calls and tracks their results', () => {
  const { steps, added } = fixture();
  const first = steps.onToolCall('c1', 'bash', '{"command":"npm test"}', 1, 1);
  const group = steps.group;
  assert.equal(added.length, 1);
  assert.equal(added[0], group);
  assert.equal(first.status, 'running');

  const second = steps.onToolCall('c2', 'read', '{"path":"README.md"}', 1, 1);
  assert.equal(steps.group, group);
  assert.equal(group.rows.length, 2);
  assert.equal(second.name, 'read');

  steps.onToolResult('c1', '2 passed', false);
  steps.onToolResult('c2', 'contents', false);
  assert.equal(first.status, 'done');
  assert.equal(second.status, 'done');
  assert.ok(group.revision >= 3);
});

test('starts a new group at the next step and handles unknown results', () => {
  const { steps, added } = fixture();
  steps.onToolCall('c1', 'bash', '{}', 1, 1);
  const first = steps.group;
  steps.startStep(1, 2);
  assert.equal(steps.group, null);
  steps.onToolCall('c2', 'read', '{}', 1, 2);
  const second = steps.group;
  assert.notEqual(second, first);
  assert.equal(added.length, 2);
  assert.equal(first.running, false);

  const fallback = steps.onToolResult('missing', 'lost output', true);
  assert.equal(fallback.status, 'error');
  assert.equal(steps.group, second);
  assert.equal(second.rows.at(-1), fallback);
});

test('attaches and removes reasoning in the current group', () => {
  const { steps, added, removed } = fixture();
  const standalone = new ReasoningRow('before tools');
  assert.equal(steps.attachReasoning(standalone), null);
  assert.equal(added.at(-1), standalone);

  steps.onToolCall('c1', 'bash', '{}', 1, 1);
  const group = steps.group;
  const attached = new ReasoningRow('after tools');
  assert.equal(steps.attachReasoning(attached), group);
  assert.equal(group.rows.at(-1), attached);
  steps.updateReasoning(attached);
  assert.ok(group.revision >= 2);

  steps.removeReasoning(attached);
  assert.equal(group.rows.length, 1);
  steps.removeReasoning(standalone);
  assert.equal(removed.at(-1), standalone);
});

test('clears row maps when a group is trimmed', () => {
  const { steps } = fixture();
  steps.onToolCall('c1', 'bash', '{}', 1, 1);
  const group = steps.group;
  steps.trim(new Set([group]));
  assert.equal(steps.group, null);
  assert.equal(steps.rowFor('c1'), undefined);
  steps.clear();
  assert.equal(steps.rowFor('c1'), undefined);
});
