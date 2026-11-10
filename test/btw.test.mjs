import assert from 'node:assert/strict';
import test from 'node:test';

import { askBtw, buildBtwTranscript, resolveBtwRoute } from '../lib/host/btw.js';

test('flattens completed conversation and labels tool results', () => {
  const transcript = buildBtwTranscript([
    { role: 'system', content: [{ type: 'text', text: 'ignore' }] },
    { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'looking' },
        { type: 'tool-call', id: 'c1', name: 'read' },
      ],
    },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }] },
  ]);
  assert.deepEqual(transcript.entries, [
    { role: 'user', text: 'fix it' },
    { role: 'assistant', text: 'looking' },
    { role: 'user', text: 'Tool result (read):\nfile body' },
  ]);
});

test('omits middle messages when the transcript exceeds its budget', () => {
  const transcript = buildBtwTranscript([
    { role: 'user', content: [{ type: 'text', text: 'head' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(80) }] },
    { role: 'user', content: [{ type: 'text', text: 'y'.repeat(80) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'tail' }] },
  ], { maxContextChars: 28 });
  assert.equal(transcript.omitted, 2);
  assert.equal(transcript.entries[0].text, 'head');
  assert.equal(transcript.entries.at(-1).text, 'tail');
});

test('resolves the session selection before the request header and defaults', () => {
  const ctx = {
    get(name) {
      if (name === 'sessionProjections') return { stateOf: () => ({ pending: { provider: 'p', model: 'm', reasoningEffort: 'high' } }) };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'd', model: 'd' }) };
      return undefined;
    },
  };
  const agent = { session: { requestHeader: () => ({ config: { provider: 'r', model: 'r' } }) } };
  assert.deepEqual(resolveBtwRoute(ctx, agent), { provider: 'p', model: 'm', reasoningEffort: 'high' });
});

test('asks the same route without tools and returns answer and reasoning', async () => {
  let request;
  const ctx = {
    get(name) {
      if (name === 'llm') {
        return {
          async *stream(options) {
            request = options;
            yield { type: 'reasoning-delta', text: 'think' };
            yield { type: 'text-delta', text: 'answer' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return undefined;
    },
  };
  const agent = { id: 's1', session: { deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] } };
  const result = await askBtw(ctx, agent, 'why?');
  assert.equal(result.answer, 'answer');
  assert.equal(result.reasoning, 'think');
  assert.equal(result.provider, 'p');
  assert.equal(request.provider, 'p');
  assert.equal(request.tools, undefined);
  assert.match(request.system, /SIDE_QUESTION_POLICY/);
  assert.equal(request.messages.at(-1).content[0].text, 'why?');
});
