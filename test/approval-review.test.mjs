import assert from 'node:assert/strict';
import test from 'node:test';

import { fallbackSuggestion, parseReview, parseSuggestion, reviewApproval, suggestApprovalRule } from '../lib/host/approval-review.js';

const payload = {
  toolName: 'bash',
  arguments: { command: 'npm test' },
  currentSandbox: 'workspace-write',
  rule: { id: 'tests', tool: 'bash', command: '^npm test' },
};

test('parses only strict reviewer JSON', () => {
  assert.deepEqual(parseReview('{"verdict":"allow","reason":"ok"}'), { verdict: 'allow', reason: 'ok' });
  assert.deepEqual(parseReview('```json\n{"verdict":"allow"}\n```'), { verdict: 'allow', reason: '' });
  assert.equal(parseReview('deny').verdict, 'ask');
  assert.equal(parseReview('{"verdict":"other"}').verdict, 'ask');
});

test('reviews with the session route and no tools', async () => {
  let request;
  const ctx = {
    get(name) {
      if (name === 'llm') {
        return {
          async *stream(options) {
            request = options;
            yield { type: 'text-delta', text: '{"verdict":"allow","reason":"matches"}' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return undefined;
    },
  };
  const agent = { id: 's1', session: { deriveMessages: () => [] } };
  const result = await reviewApproval(ctx, agent, payload);
  assert.equal(result.verdict, 'allow');
  assert.equal(result.reason, 'matches');
  assert.equal(request.tools, undefined);
  assert.equal(request.provider, 'p');
  assert.match(request.system, /APPROVAL_REVIEW_POLICY/);
  assert.match(request.messages[0].content[0].text, /"rule"/);
});

test('parses a suggested narrow rule and rejects malformed suggestions', () => {
  assert.deepEqual(parseSuggestion('{"rule":{"id":"tests","tool":"bash","command":"^npm test","description":"tests"},"reason":"narrow"}'), {
    rule: { id: 'tests', tool: 'bash', command: '^npm test', description: 'tests' },
    reason: 'narrow',
  });
  assert.throws(() => parseSuggestion('{"rule":{}}'), /no tool/u);
  assert.throws(() => parseSuggestion('nope'), /no suggestion JSON/u);
});


test('builds an exact-call fallback rule when the reviewer returns prose', async () => {
  const ctx = {
    get(name) {
      if (name === 'llm') {
        return {
          async *stream() {
            yield { type: 'text-delta', text: 'I cannot propose a rule.' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return undefined;
    },
  };
  const agent = { id: 's1', session: { deriveMessages: () => [] } };
  const result = await suggestApprovalRule(ctx, agent, {
    context: {
      toolName: 'bash',
      arguments: { command: 'npm test && echo "done"' },
      requestedSandbox: null,
    },
  });
  assert.equal(result.fallback, true);
  assert.equal(result.rule.tool, 'bash');
  assert.equal(result.rule.command, '^npm test && echo "done"$');
  assert.match(result.rule.id, /^bash-npm-test/u);
});

test('does not fallback when the reviewer returns a usable rule', () => {
  assert.equal(fallbackSuggestion(null), null);
  assert.equal(fallbackSuggestion({ context: {} }), null);
  const fallback = fallbackSuggestion({ context: { toolName: 'read', arguments: { path: 'src/a.js' } } });
  assert.equal(fallback.rule.path, '^src/a\\.js$');
});

test('accepts a verdict emitted only in the reasoning channel', async () => {
  let request;
  const ctx = {
    get(name) {
      if (name === 'llm') {
        return {
          async *stream(options) {
            request = options;
            yield { type: 'reasoning-delta', text: '{"verdict":"allow","reason":"from reasoning"}' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return undefined;
    },
  };
  const agent = { id: 's1', session: { deriveMessages: () => [] } };
  const result = await reviewApproval(ctx, agent, payload);
  assert.deepEqual(result, { verdict: 'allow', reason: 'from reasoning' });
  assert.ok(request.maxTokens >= 1024);
});
