import assert from 'node:assert/strict';
import test from 'node:test';

import { parseReview, reviewApproval } from '../lib/host/approval-review.js';

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
