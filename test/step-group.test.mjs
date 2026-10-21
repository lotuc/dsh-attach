import assert from 'node:assert/strict';
import test from 'node:test';

import { ReasoningRow, StepGroupRow, ToolRow, isCommandTool, isEditTool, isReadTool } from '../lib/client/transcript.js';

test('recognizes command, edit, and read tools', () => {
  assert.equal(isCommandTool('bash'), true);
  assert.equal(isCommandTool('shell'), true);
  assert.equal(isEditTool('edit'), true);
  assert.equal(isReadTool('read'), true);
  assert.equal(isCommandTool('read'), false);
});

test('renders a collapsed step group with running and completed states', () => {
  let expanded = false;
  const group = new StepGroupRow(() => expanded);
  const first = new ToolRow('bash', JSON.stringify({ command: 'npm test' }), () => expanded);
  group.addTool('bash', first);

  assert.match(group.render(100).join('\n'), /Running commands/);
  assert.equal(group.status, 'running');

  first.finish('2 tests passed', false);
  group.finish();
  group.revision += 1;
  assert.equal(group.status, 'done');
  const collapsed = group.render(100).join('\n');
  assert.match(collapsed, /Ran commands/);
  assert.doesNotMatch(collapsed, /2 tests passed/);

  expanded = true;
  const open = group.render(100).join('\n');
  assert.match(open, /npm test/);
  assert.match(open, /2 tests passed/);
});

test('reports failures and expands all child commands', () => {
  let expanded = true;
  const group = new StepGroupRow(() => expanded);
  const ok = new ToolRow('bash', JSON.stringify({ command: 'npm run build' }), () => expanded);
  const bad = new ToolRow('bash', JSON.stringify({ command: 'npm test' }), () => expanded);
  ok.finish('built', false);
  bad.finish('failed', true);
  group.addTool('bash', ok);
  group.addTool('bash', bad);
  group.finish();

  assert.equal(group.status, 'error');
  const lines = group.render(100).join('\n');
  assert.match(lines, /Ran commands/);
  assert.match(lines, /1 failed/);
  assert.match(lines, /npm run build/);
  assert.match(lines, /failed/);
});

test('includes thinking and file tools in the step label', () => {
  let expanded = true;
  const group = new StepGroupRow(() => expanded);
  const command = new ToolRow('bash', JSON.stringify({ command: 'npm test' }), () => expanded);
  const edit = new ToolRow('edit', JSON.stringify({ path: 'src/app.js' }), () => expanded);
  const read = new ToolRow('read', JSON.stringify({ path: 'README.md' }), () => expanded);
  command.finish('ok', false);
  edit.finish('updated', false);
  read.finish('contents', false);
  group.addTool('bash', command);
  group.addTool('edit', edit);
  group.addTool('read', read);
  group.addReasoning(new ReasoningRow('consider the next step', () => false));
  group.finish();

  const lines = group.render(120).join('\n');
  assert.match(lines, /Ran commands, edited files and read files/);
  assert.match(lines, /Think/);
  assert.match(lines, /consider the next step/);
});
