import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findExecApprovalRule, loadExecApprovalRules, resolveExecApprovalRulesPath } from '../lib/client/exec-rules.js';
import { normalizeAutoApprovalConfig } from '../lib/client/auto-approval.js';

async function withRules(text, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-rules-'));
  const path = join(dir, 'approval.toml');
  await writeFile(path, text);
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('loads scoped TOML rules and enables an explicit file by default', async () => {
  await withRules(`
mode = "rules"
[[rules]]
id = "tests"
tool = "bash"
command_prefix = ["npm", "test"]
`, async (path) => {
    const config = await loadExecApprovalRules(path);
    assert.equal(config.enabled, true);
    assert.equal(config.mode, 'rules');
    assert.equal(config.rules[0].id, 'tests');
    assert.deepEqual(config.rules[0].commandPrefix, ['npm', 'test']);
  });
});

test('honors an explicit enabled = false', async () => {
  await withRules('enabled = false\n[[rules]]\nid = "x"\ntool = "bash"\n', async (path) => {
    await assert.rejects(
      loadExecApprovalRules(path),
      (error) => error?.code === 'attach/exec-rules' && /disabled/.test(error.message),
    );
  });
});

test('reports unreadable and malformed rule files', async () => {
  await assert.rejects(
    loadExecApprovalRules('/definitely/missing/dsh-attach-rules.toml'),
    (error) => error?.code === 'attach/exec-rules' && /cannot read/.test(error.message),
  );
  await withRules('rules = [', async (path) => {
    await assert.rejects(
      loadExecApprovalRules(path),
      (error) => error?.code === 'attach/exec-rules' && /cannot parse/.test(error.message),
    );
  });
});

test('matches explicit rules for safe commands and non-shell tools', () => {
  const config = normalizeAutoApprovalConfig({
    enabled: true,
    mode: 'rules',
    allowFullAccess: true,
    rules: [
      { id: 'pwd', tool: 'bash', commandPrefix: ['pwd'], sandbox: 'danger-full-access', allowFullAccess: true },
      { id: 'source', tool: 'write', pathPrefix: '/repo/src/' },
    ],
  });
  const pwd = {
    toolName: 'bash',
    cwd: '/repo',
    arguments: { command: 'pwd', sandbox_permissions: 'danger-full-access' },
    requestedSandbox: 'danger-full-access',
    currentSandbox: 'workspace-write',
  };
  assert.equal(findExecApprovalRule(config, pwd)?.id, 'pwd');
  assert.equal(findExecApprovalRule(config, {
    toolName: 'write',
    cwd: '/repo',
    arguments: { path: '/repo/src/main.js' },
  })?.id, 'source');
  assert.equal(findExecApprovalRule(config, {
    toolName: 'bash',
    cwd: '/repo',
    arguments: { command: 'pwd && rm -rf /' },
  }), null);
});

test('resolves @default to the TUI auto-approval file', () => {
  assert.equal(
    resolveExecApprovalRulesPath('@default', { DSH_HOME: '/home/test', DSH_ATTACH_AUTO_APPROVE: '/policy/custom.toml' }),
    '/policy/custom.toml',
  );
  assert.equal(
    resolveExecApprovalRulesPath('@default', { DSH_HOME: '/home/test', DSH_ATTACH_AUTO_APPROVE: 'off' }),
    '/home/test/dsh-attach/auto-approve.toml',
  );
  assert.equal(
    resolveExecApprovalRulesPath('@default', { DSH_HOME: '/home/test' }),
    '/home/test/dsh-attach/auto-approve.toml',
  );
  assert.equal(resolveExecApprovalRulesPath('./approval.toml', { DSH_HOME: '/home/test' }), './approval.toml');
  assert.throws(
    () => resolveExecApprovalRulesPath('  ', {}),
    (error) => error?.code === 'attach/exec-rules',
  );
});

test('loads @default from DSH_HOME', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-home-'));
  await mkdir(join(home, 'dsh-attach'));
  const path = join(home, 'dsh-attach', 'auto-approve.toml');
  await writeFile(path, 'mode = "rules"\n[[rules]]\nid = "tests"\ntool = "bash"\ncommand_prefix = ["npm", "test"]\n');
  const previous = process.env.DSH_HOME;
  const previousRules = process.env.DSH_ATTACH_AUTO_APPROVE;
  process.env.DSH_HOME = home;
  delete process.env.DSH_ATTACH_AUTO_APPROVE;
  try {
    const config = await loadExecApprovalRules('@default');
    assert.equal(config.enabled, true);
    assert.equal(config.rules[0].id, 'tests');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    if (previousRules === undefined) delete process.env.DSH_ATTACH_AUTO_APPROVE;
    else process.env.DSH_ATTACH_AUTO_APPROVE = previousRules;
    await rm(home, { recursive: true, force: true });
  }
});
