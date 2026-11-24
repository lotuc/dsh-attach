import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findExecApprovalRule, loadExecApprovalRules } from '../lib/client/exec-rules.js';
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
