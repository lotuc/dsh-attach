import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fallbackSuggestion,
  parseReview,
  parseSuggestion,
  reviewApproval,
  suggestApprovalRule,
  suggestionMatchesContext,
} from '../lib/host/approval-review.js';

const payload = {
  toolName: 'bash',
  cwd: '/workspace/project',
  arguments: { command: 'npm test' },
  currentSandbox: 'workspace-write',
  rule: { id: 'tests', tool: 'bash', commandPrefix: ['npm', 'test'] },
};

function modelContext(stream) {
  return {
    get(name) {
      if (name === 'llm') return { stream };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return undefined;
    },
  };
}

test('parses only strict reviewer JSON', () => {
  assert.deepEqual(parseReview('{"verdict":"allow","reason":"ok"}'), { verdict: 'allow', reason: 'ok' });
  assert.deepEqual(parseReview('```json\n{"verdict":"allow"}\n```'), { verdict: 'allow', reason: '' });
  assert.equal(parseReview('deny').verdict, 'ask');
  assert.equal(parseReview('{"verdict":"other"}').verdict, 'ask');
});

test('reviews with the session route and no tools', async () => {
  let request;
  const ctx = modelContext(async function* stream(options) {
    request = options;
    yield { type: 'text-delta', text: '{"verdict":"allow","reason":"matches"}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const agent = { id: 's1', session: { deriveMessages: () => [] } };
  const result = await reviewApproval(ctx, agent, payload);
  assert.equal(result.verdict, 'allow');
  assert.equal(result.reason, 'matches');
  assert.equal(request.tools, undefined);
  assert.equal(request.provider, 'p');
  assert.match(request.system, /APPROVAL_REVIEW_POLICY/);
  assert.match(request.messages[0].content[0].text, /"commandPrefix"/);
});

test('parses a suggested token-prefix rule and rejects malformed suggestions', () => {
  assert.deepEqual(parseSuggestion('{"rule":{"id":"tests","tool":"bash","commandPrefix":["npm","test"],"description":"tests"},"reason":"narrow"}'), {
    rule: { id: 'tests', tool: 'bash', commandPrefix: ['npm', 'test'], description: 'tests' },
    reason: 'narrow',
  });
  assert.throws(() => parseSuggestion('{"rule":{}}'), /no tool/u);
  assert.throws(() => parseSuggestion('nope'), /no suggestion JSON/u);
});

test('builds an exact first-command fallback when the reviewer returns prose', async () => {
  const ctx = modelContext(async function* stream() {
    yield { type: 'text-delta', text: 'I cannot propose a rule.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const agent = { id: 's1', session: { deriveMessages: () => [] } };
  const result = await suggestApprovalRule(ctx, agent, {
    context: {
      toolName: 'bash',
      cwd: '/workspace/project',
      arguments: { command: 'npm test && echo done' },
      requestedSandbox: null,
    },
  });
  assert.equal(result.fallback, true);
  assert.equal(result.rule.tool, 'bash');
  assert.deepEqual(result.rule.commandPrefix, ['npm', 'test']);
});

test('does not fallback when the reviewer returns a usable rule', () => {
  assert.equal(fallbackSuggestion(null), null);
  assert.equal(fallbackSuggestion({ context: {} }), null);
  const fallback = fallbackSuggestion({ context: { toolName: 'read', arguments: { path: 'src/a.js' } } });
  assert.equal(fallback.rule.pathPrefix, 'src/a.js');
});

test('maps a full-access approval to a full-access fallback rule', () => {
  const fallback = fallbackSuggestion({
    context: {
      toolName: 'bash',
      cwd: '/workspace/project',
      arguments: { command: 'cd /workspace/project && clojure -T:build uber' },
      requestedSandbox: 'danger-full-access',
    },
  });
  assert.deepEqual(fallback.rule.commandPrefix, ['clojure', '-T:build', 'uber']);
  assert.equal(fallback.rule.sandbox, 'danger-full-access');
  assert.equal(fallback.rule.allowFullAccess, true);
});

test('rejects a copied template suggestion and falls back to the first command', async () => {
  const ctx = modelContext(async function* stream() {
    yield {
      type: 'text-delta',
      text: '{"rule":{"id":"...","tool":"bash","commandPrefix":["command"],"description":"..."},"reason":"..."}',
    };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const agent = { id: 's1', session: { deriveMessages: () => [] } };
  const payload = { context: { toolName: 'bash', cwd: '/workspace', arguments: { command: 'npm test' }, requestedSandbox: null } };
  const result = await suggestApprovalRule(ctx, agent, payload);
  assert.equal(result.fallback, true);
  assert.deepEqual(result.rule.commandPrefix, ['npm', 'test']);
});

test('validates a suggestion against the actual approval context', () => {
  const context = { toolName: 'bash', cwd: '/workspace/project', arguments: { command: 'npm test' }, requestedSandbox: null };
  assert.equal(suggestionMatchesContext({ tool: 'bash', commandPrefix: ['npm', 'test'] }, context), true);
  assert.equal(suggestionMatchesContext({ tool: 'bash', commandPrefix: ['npm', 'run'] }, context), false);
  assert.equal(suggestionMatchesContext({ tool: 'other', commandPrefix: ['npm', 'test'] }, context), false);
  assert.equal(suggestionMatchesContext({ tool: 'bash', commandPrefix: ['npm', 'test'], sandbox: 'workspace-write' }, context), false);
});

test('accepts a verdict emitted only in the reasoning channel', async () => {
  let request;
  const ctx = modelContext(async function* stream(options) {
    request = options;
    yield { type: 'reasoning-delta', text: '{"verdict":"allow","reason":"from reasoning"}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const agent = { id: 's1', session: { deriveMessages: () => [] } };
  const result = await reviewApproval(ctx, agent, payload);
  assert.deepEqual(result, { verdict: 'allow', reason: 'from reasoning' });
  assert.ok(request.maxTokens >= 1024);
});
