import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeSessionRule,
  isOutsideWorkspace,
  normalizeSessionRule,
  parentDirectoryOf,
  resolveRulePath,
  sandboxEscalates,
  sessionRuleFrom,
  sessionRuleId,
  sessionRuleMatches,
} from '../lib/shared/session-allow.js';

const bashContext = (command, extra = {}) => ({
  toolName: 'bash',
  cwd: '/work',
  arguments: { command, ...extra },
  requestedSandbox: extra.sandbox_permissions ?? null,
});

test('derives a narrow bash prefix and keeps the requested sandbox', () => {
  const rule = sessionRuleFrom(bashContext('npm test -- --runInBand', { sandbox_permissions: 'workspace-write' }));
  assert.deepEqual(rule, {
    tool: 'bash',
    commandPrefix: ['npm', 'test'],
    sandbox: 'workspace-write',
  });
  assert.match(describeSessionRule(rule), /bash · npm test · workspace-write/u);
});

test('derives a resolved path prefix for a file tool', () => {
  const rule = sessionRuleFrom({
    toolName: 'write',
    cwd: '/work/project',
    arguments: { file_path: '../outside/notes.txt', content: 'hi' },
  });
  assert.deepEqual(rule, { tool: 'write', pathPrefix: '/work/outside/notes.txt' });
  assert.equal(sessionRuleId(rule), 'session-write-work-outside-notes-txt');
});

test('a danger-full-access rule must be explicit and carries the marker', () => {
  const rule = sessionRuleFrom(bashContext('rm -rf build', { sandbox_permissions: 'danger-full-access' }));
  assert.deepEqual(rule, {
    tool: 'bash',
    commandPrefix: ['rm'],
    sandbox: 'danger-full-access',
    allowFullAccess: true,
  });
  assert.match(describeSessionRule(rule), /DANGER/u);
});

test('a compound call derives a rule only when the prefix covers every segment', () => {
  assert.deepEqual(sessionRuleFrom(bashContext('npm test && echo done')), { tool: 'bash', commandPrefix: ['npm', 'test'] });
  assert.deepEqual(sessionRuleFrom(bashContext('npm test && npm test -- --watch')), { tool: 'bash', commandPrefix: ['npm', 'test'] });
  assert.equal(
    sessionRuleFrom(bashContext('npm test && rm -rf build')),
    null,
    'a mixed compound line would never match its own rule',
  );
});

test('unparseable or empty calls derive no rule', () => {
  assert.equal(sessionRuleFrom(bashContext('echo $(rm -rf /)')), null);
  assert.equal(sessionRuleFrom(bashContext('cd /tmp')), null);
  assert.equal(sessionRuleFrom({ toolName: 'bash', arguments: {} }), null);
  assert.equal(sessionRuleFrom({ toolName: 'bash', cwd: '/work', arguments: { command: 'ls' }, requestedSandbox: 'bogus' }).sandbox, undefined);
  assert.equal(sessionRuleFrom(null), null);
  assert.equal(sessionRuleFrom({ toolName: 'write', arguments: { content: 'no path' } }), null);
});

test('normalizes only narrow, well-formed rules', () => {
  assert.deepEqual(normalizeSessionRule({ tool: 'bash', commandPrefix: 'npm test' }), {
    tool: 'bash',
    commandPrefix: ['npm', 'test'],
  });
  assert.deepEqual(normalizeSessionRule({ tool: 'bash', commandPrefix: ['git', 'log'], sandbox: 'read-only' }), {
    tool: 'bash',
    commandPrefix: ['git', 'log'],
    sandbox: 'read-only',
  });
  assert.equal(normalizeSessionRule({ tool: 'bash' }), null, 'a rule with no prefix matches everything');
  assert.equal(normalizeSessionRule({ tool: 'bash', sandbox: 'root' }), null);
  assert.equal(normalizeSessionRule({ tool: 'two words', pathPrefix: '/x' }), null);
  assert.equal(normalizeSessionRule({ tool: 'bash', pathPrefix: 'relative/path' }).pathPrefix, 'relative/path');
  assert.equal(normalizeSessionRule({ tool: 'bash', pathPrefix: '' }), null);
  assert.equal(normalizeSessionRule('nope'), null);
  assert.deepEqual(
    normalizeSessionRule({ tool: 'bash', commandPrefix: ['rm'], sandbox: 'danger-full-access' }),
    { tool: 'bash', commandPrefix: ['rm'], sandbox: 'danger-full-access', allowFullAccess: true },
  );
  assert.equal(
    normalizeSessionRule({ tool: 'bash', commandPrefix: ['rm'], allowFullAccess: true }),
    null,
    'a full-access marker without the matching sandbox is refused',
  );
});

test('a session rule matches the same call and required sandbox', () => {
  const rule = normalizeSessionRule({ tool: 'bash', commandPrefix: ['npm', 'test'], sandbox: 'workspace-write' });
  assert.equal(sessionRuleMatches(rule, bashContext('npm test', { sandbox_permissions: 'workspace-write' })), true);
  assert.equal(sessionRuleMatches(rule, bashContext('npm test --watch', { sandbox_permissions: 'workspace-write' })), true);
  assert.equal(sessionRuleMatches(rule, bashContext('npm install', { sandbox_permissions: 'workspace-write' })), false);
  assert.equal(sessionRuleMatches(rule, bashContext('npm test')), false, 'requested sandbox must match');
  assert.equal(sessionRuleMatches(rule, { ...bashContext('npm test', { sandbox_permissions: 'workspace-write' }), toolName: 'write' }), false);

  const plain = normalizeSessionRule({ tool: 'bash', commandPrefix: ['npm', 'test'] });
  assert.equal(sessionRuleMatches(plain, bashContext('npm test')), true);
  assert.equal(
    sessionRuleMatches(plain, bashContext('npm test', { sandbox_permissions: 'workspace-write' })),
    false,
    'a plain rule must not cover a later escalated call',
  );
});

test('compound lines need every non-read-only segment to match', () => {
  const rule = normalizeSessionRule({ tool: 'bash', commandPrefix: ['npm', 'test'] });
  assert.equal(sessionRuleMatches(rule, bashContext('npm test && echo done')), true);
  assert.equal(sessionRuleMatches(rule, bashContext('npm test && rm -rf build')), false);
  assert.equal(sessionRuleMatches(rule, bashContext('echo $(npm test)')), false, 'substitution fails closed');
  assert.equal(sessionRuleMatches(rule, bashContext('for x in a; do npm test; done')), false);
});

test('danger-full-access never matches without the explicit marker', () => {
  const context = bashContext('rm -rf build', { sandbox_permissions: 'danger-full-access' });
  assert.equal(
    sessionRuleMatches({ tool: 'bash', commandPrefix: ['rm'], sandbox: 'danger-full-access' }, context),
    false,
    'the marker is required even when the sandbox matches',
  );
  assert.equal(
    sessionRuleMatches(
      { tool: 'bash', commandPrefix: ['rm'], sandbox: 'danger-full-access', allowFullAccess: true },
      context,
    ),
    true,
  );
});

test('path rules resolve relative targets and stay inside the prefix', () => {
  const rule = normalizeSessionRule({ tool: 'write', pathPrefix: '/work/outside' });
  assert.equal(sessionRuleMatches(rule, { toolName: 'write', cwd: '/work', arguments: { file_path: 'outside/a.txt' } }), true);
  assert.equal(sessionRuleMatches(rule, { toolName: 'write', cwd: '/work', arguments: { file_path: 'inside.txt' } }), false);
  assert.equal(sessionRuleMatches(rule, { toolName: 'write', cwd: '/work', arguments: { command: 'ls' } }), false, 'a path rule must not match a shell call');
});

test('path helpers keep host and terminal comparisons consistent', () => {
  assert.equal(resolveRulePath('/work/a/../b', '/work'), '/work/b');
  assert.equal(resolveRulePath('a/./b/', '/work'), '/work/a/b');
  assert.equal(resolveRulePath('~/.cache', '/work', '/home/user'), '/home/user/.cache');
  assert.equal(resolveRulePath('~', '/work', '/home/user'), '/home/user');
  assert.equal(resolveRulePath('~/logs/./a.txt', '/work', '/home/user'), '/home/user/logs/a.txt');
  assert.equal(resolveRulePath('~other/file', '/work', '/home/user'), '~other/file', 'only a bare ~ or ~/ expands');
  assert.equal(parentDirectoryOf('/work/a/b.txt'), '/work/a');
  assert.equal(isOutsideWorkspace('/work/a.txt', '/work'), false);
  assert.equal(isOutsideWorkspace('/other/a.txt', '/work'), true);
  assert.equal(isOutsideWorkspace('/other/a.txt', ''), false);
});

test('sandbox escalation ranks only wider requests', () => {
  assert.equal(sandboxEscalates('workspace-write', 'danger-full-access'), true);
  assert.equal(sandboxEscalates('workspace-write', 'read-only'), false);
  assert.equal(sandboxEscalates('danger-full-access', 'danger-full-access'), false);
  assert.equal(sandboxEscalates(null, 'workspace-write'), true);
  assert.equal(sandboxEscalates(null, 'danger-full-access'), true);
  assert.equal(sandboxEscalates('workspace-write', null), false);
});
