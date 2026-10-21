import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandGroupRow, ToolRow, isCommandTool } from '../lib/client/transcript.js';

test('recognizes shell command tools', () => {
  assert.equal(isCommandTool('bash'), true);
  assert.equal(isCommandTool('shell'), true);
  assert.equal(isCommandTool('read'), false);
});

test('renders a collapsed command group with running and completed states', () => {
  let expanded = false;
  const group = new CommandGroupRow(() => expanded);
  const first = new ToolRow('bash', JSON.stringify({ command: 'npm test' }), () => expanded);
  group.add(first);

  assert.match(group.render(100).join('\n'), /Running commands/);
  assert.equal(group.status, 'running');

  first.finish('2 tests passed', false);
  group.revision += 1;
  assert.equal(group.status, 'done');
  const collapsed = group.render(100).join('\n');
  assert.match(collapsed, /Ran commands/);
  assert.match(collapsed, /1 command/);
  assert.doesNotMatch(collapsed, /2 tests passed/);

  expanded = true;
  const open = group.render(100).join('\n');
  assert.match(open, /npm test/);
  assert.match(open, /2 tests passed/);
});

test('reports failures and expands all child commands', () => {
  let expanded = true;
  const group = new CommandGroupRow(() => expanded);
  const ok = new ToolRow('bash', JSON.stringify({ command: 'npm run build' }), () => expanded);
  const bad = new ToolRow('bash', JSON.stringify({ command: 'npm test' }), () => expanded);
  ok.finish('built', false);
  bad.finish('failed', true);
  group.add(ok);
  group.add(bad);

  assert.equal(group.status, 'error');
  const lines = group.render(100).join('\n');
  assert.match(lines, /Ran commands/);
  assert.match(lines, /1 failed/);
  assert.match(lines, /npm run build/);
  assert.match(lines, /failed/);
});
