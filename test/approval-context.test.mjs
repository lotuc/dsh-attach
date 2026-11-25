import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { approvalExtraSections, approvalRisk } from '../lib/client/approval-context.js';

test('approval extras show the target, proposed edit and session context', () => {
  const sections = approvalExtraSections(JSON.stringify({
    path: '/tmp/repo/src/app.js',
    old_string: 'const a = 1;',
    new_string: 'const a = 2;',
  }), {
    sessionId: 's1',
    cwd: '/tmp/repo',
    permission: 'workspace-write',
    provider: 'deepseek',
    model: 'chat',
  });

  assert.deepEqual(sections.map((section) => section.label), [
    'Target',
    'Proposed edit',
    'Context',
  ]);
  assert.equal(sections[0].text, '/tmp/repo/src/app.js');
  assert.match(sections[1].text, /^--- \/tmp\/repo\/src\/app\.js/m);
  assert.match(sections[1].text, /^- const a = 1;/m);
  assert.match(sections[1].text, /^\+ const a = 2;/m);
  assert.match(sections[2].text, /working directory: \/tmp\/repo/);
  assert.match(sections[2].text, /sandbox: workspace-write/);
  assert.match(sections[2].text, /model: deepseek\/chat/);
});

test('approval extras prefer a supplied unified diff', () => {
  const sections = approvalExtraSections(JSON.stringify({
    file_path: 'src/a.js',
    diff: '@@ -1 +1 @@\n-old\n+new',
  }));
  assert.deepEqual(sections.map((section) => section.label), ['Target', 'Proposed diff']);
  assert.match(sections[1].text, /^@@/);
});

test('approval extras stay empty for plain command arguments', () => {
  assert.deepEqual(approvalExtraSections(JSON.stringify({ command: 'npm test' })), []);
  assert.deepEqual(approvalExtraSections('not json'), []);
  assert.deepEqual(approvalExtraSections(''), []);
});

test('approval risk surfaces escalation, justification and an outside target', () => {
  const risk = approvalRisk(JSON.stringify({
    file_path: '/outside/project/a.txt',
    sandbox_permissions: 'danger-full-access',
    justification: 'the log lives outside the workspace',
  }), { cwd: '/work', permission: 'workspace-write', reason: 'write a log' });
  assert.equal(risk.escalates, true);
  assert.equal(risk.fullAccess, true);
  assert.equal(risk.currentSandbox, 'workspace-write');
  assert.equal(risk.requestedSandbox, 'danger-full-access');
  assert.equal(risk.target, '/outside/project/a.txt');
  assert.equal(risk.resolvedTarget, '/outside/project/a.txt');
  assert.equal(risk.outsideWorkspace, true);
  assert.equal(risk.parentDirectory, '/outside/project');
  assert.equal(risk.justification, 'the log lives outside the workspace');
});

test('approval risk resolves relative targets and suppresses a duplicate reason', () => {
  const risk = approvalRisk(JSON.stringify({
    path: '../outside/a.txt',
    justification: 'write a log',
  }), { cwd: '/work/repo', permission: 'workspace-write', reason: 'write a log' });
  assert.equal(risk.escalates, false);
  assert.equal(risk.requestedSandbox, '');
  assert.equal(risk.resolvedTarget, '/work/outside/a.txt');
  assert.equal(risk.outsideWorkspace, true);
  assert.equal(risk.justification, '', 'justification equal to the reason adds no information');
});

test('approval risk expands a home-relative target for the outside marker', () => {
  const home = homedir();
  const risk = approvalRisk(JSON.stringify({ file_path: '~/logs/a.txt' }), {
    cwd: '/work/repo',
    permission: 'workspace-write',
  });
  assert.equal(risk.resolvedTarget, join(home, 'logs', 'a.txt'));
  assert.equal(risk.outsideWorkspace, true);
  assert.equal(risk.parentDirectory, join(home, 'logs'));
});

test('approval risk treats a same-mode request as no escalation and malformed input as empty', () => {
  const same = approvalRisk(JSON.stringify({ command: 'npm test', sandbox_permissions: 'workspace-write' }), {
    cwd: '/work',
    permission: 'workspace-write',
  });
  assert.equal(same.escalates, false);
  assert.equal(same.requestedSandbox, 'workspace-write');
  assert.equal(same.target, '');
  assert.equal(same.outsideWorkspace, false);

  const invalid = approvalRisk('not json', { cwd: '/work', permission: 'read-only' });
  assert.deepEqual(invalid, {
    target: '',
    resolvedTarget: '',
    outsideWorkspace: false,
    parentDirectory: '',
    justification: '',
    requestedSandbox: '',
    currentSandbox: 'read-only',
    escalates: false,
    fullAccess: false,
  });
});
