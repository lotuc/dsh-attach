import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReviewPayload,
  findAutoApprovalRule,
  normalizeAutoApprovalConfig,
  normalizeReviewVerdict,
  parseToolArguments,
  ruleMatches,
} from '../lib/client/auto-approval.js';
import { parseReview } from '../lib/host/approval-review.js';

const config = normalizeAutoApprovalConfig({
  enabled: true,
  rules: [
    { id: 'tests', tool: 'bash', command: '^npm test\\b', sandbox: 'workspace-write' },
    { id: 'jolt', tool: 'bash', command: '^jolt test\\b', sandbox: 'danger-full-access', allowFullAccess: true },
    { id: 'read', tool: 'read', path: '^/workspace/' },
  ],
});

const context = (overrides = {}) => ({
  toolName: 'bash',
  arguments: { command: 'npm test -- --run', sandbox_permissions: 'workspace-write' },
  reason: 'run tests',
  currentSandbox: 'workspace-write',
  requestedSandbox: 'workspace-write',
  ...overrides,
});

test('parses and normalizes auto-approval rules', () => {
  assert.equal(config.enabled, true);
  assert.deepEqual(config.rules.map((rule) => rule.id), ['tests', 'jolt', 'read']);
  assert.equal(normalizeAutoApprovalConfig({ enabled: true, rules: [{ id: 'x', tool: 'bash', allowFullAccess: true }] }).rules[0].allowFullAccess, true);
  assert.equal(normalizeAutoApprovalConfig({ enabled: true, rules: [{ enabled: false }] }).rules.length, 0);
  assert.deepEqual(parseToolArguments('{"command":"npm test"}'), { command: 'npm test' });
  assert.equal(parseToolArguments('not json'), null);
});

test('matches a rule only within its explicit sandbox and scope', () => {
  assert.equal(ruleMatches(config.rules[0], context()), true);
  assert.equal(ruleMatches(config.rules[1], context({ arguments: { command: 'jolt test' }, requestedSandbox: 'danger-full-access' })), true);
  assert.equal(ruleMatches(config.rules[1], context({ arguments: { command: 'jolt test' }, requestedSandbox: 'workspace-write' })), false);
  assert.equal(ruleMatches(config.rules[1], context({ arguments: { command: 'jolt test' }, requestedSandbox: 'danger-full-access' })), true);
  assert.equal(ruleMatches(config.rules[0], context({ arguments: { command: 'rm -rf /' }, requestedSandbox: 'workspace-write' })), false);
  assert.equal(findAutoApprovalRule(config, context())?.id, 'tests');
  assert.equal(findAutoApprovalRule(config, context({ toolName: 'write' })), null);
});

test('requires an explicit full-access opt-in', () => {
  const without = normalizeAutoApprovalConfig({ enabled: true, rules: [{ tool: 'bash', command: '^jolt test', sandbox: 'danger-full-access' }] });
  assert.equal(findAutoApprovalRule(without, context({ arguments: { command: 'jolt test' }, requestedSandbox: 'danger-full-access' })), null);
  const withOptIn = normalizeAutoApprovalConfig({ enabled: true, rules: [{ tool: 'bash', command: '^jolt test', sandbox: 'danger-full-access', allowFullAccess: true }] });
  assert.equal(findAutoApprovalRule(withOptIn, context({ arguments: { command: 'jolt test' }, requestedSandbox: 'danger-full-access' }))?.id, 'rule-1');
});

test('builds an isolated review payload and fail-closes verdicts', () => {
  const payload = buildReviewPayload(context(), config.rules[0]);
  assert.equal(payload.rule.id, 'tests');
  assert.equal(payload.requestedSandbox, 'workspace-write');
  assert.deepEqual(normalizeReviewVerdict({ verdict: 'allow', reason: 'ok' }), { verdict: 'allow', reason: 'ok' });
  assert.deepEqual(normalizeReviewVerdict({ verdict: 'deny', reason: 'no' }), { verdict: 'ask', reason: 'no' });
  assert.deepEqual(parseReview('```json\n{"verdict":"allow","reason":"scope matches"}\n```'), { verdict: 'allow', reason: 'scope matches' });
  assert.deepEqual(parseReview('garbage'), { verdict: 'ask', reason: 'reviewer returned no JSON' });
  assert.deepEqual(parseReview('{"verdict":"deny"}'), { verdict: 'ask', reason: '' });
});
