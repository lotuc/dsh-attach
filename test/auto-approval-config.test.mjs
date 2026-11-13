import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAutoApprovalText, serializeAutoApprovalText } from '../lib/client/auto-approval-config.js';

test('parses TOML rules and maps snake_case keys', () => {
  const raw = parseAutoApprovalText(`
enabled = true
mode = "rules"
allow_full_access = true
max_auto_approvals = 100

human_only_prefixes = [["sudo"], ["git", "push"]]

[[rules]]
id = "npm"
tool = "bash"
command_prefix = ["npm", "test"]
cwd_prefix = "/repo"
allow_full_access = true
`, 'auto-approve.toml');
  assert.equal(raw.enabled, true);
  assert.equal(raw.allowFullAccess, true);
  assert.deepEqual(raw.humanOnlyPrefixes, [['sudo'], ['git', 'push']]);
  assert.deepEqual(raw.rules[0].commandPrefix, ['npm', 'test']);
  assert.equal(raw.rules[0].allowFullAccess, true);
});

test('serializes TOML and legacy JSONC', () => {
  const raw = { enabled: true, maxAutoApprovals: 50, humanOnlyPrefixes: [['sudo']], rules: [{ id: 'tests', tool: 'bash', commandPrefix: ['npm', 'test'], cwdPrefix: '/repo' }] };
  const toml = serializeAutoApprovalText(raw, 'auto-approve.toml');
  assert.match(toml, /\[\[rules\]\]/u);
  assert.match(toml, /command_prefix = \[ "npm", "test" \]/u);
  assert.match(toml, /max_auto_approvals = 50/u);
  const jsonc = serializeAutoApprovalText(raw, 'auto-approve.json');
  assert.deepEqual(parseAutoApprovalText(jsonc, 'auto-approve.json'), raw);
});
