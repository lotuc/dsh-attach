import assert from 'node:assert/strict';
import test from 'node:test';

import { createHostFixture, withAttachHost } from './helpers/attach-host.mjs';

function withBtwRoute() {
  const fixture = createHostFixture();
  fixture.agent.session.requestHeader = () => ({ config: { provider: 'p', model: 'm' } });
  fixture.agent.session.deriveMessages = () => [
    { role: 'system', content: [{ type: 'text', text: 'PROJECT_RULES' }] },
    { role: 'user', content: [{ type: 'text', text: 'main task' }] },
  ];
  return fixture;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('btw streams deltas and returns the final side answer', async () => {
  const fixture = withBtwRoute();
  let request;
  fixture.services.llm = {
    async *stream(options) {
      request = options;
      yield { type: 'reasoning-delta', text: 'think' };
      yield { type: 'text-delta', text: 'side ' };
      yield { type: 'text-delta', text: 'answer' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  await withAttachHost(async ({ client }) => {
    await client.request('session.open', { sessionId: 's1' });
    const events = [];
    client.on('btw', (message) => events.push(message));
    const result = await client.request('btw.ask', {
      question: 'why?',
      requestId: 'r1',
      history: [{ question: 'earlier', answer: 'old answer' }],
    });
    assert.equal(result.requestId, 'r1');
    assert.equal(result.answer, 'side answer');
    assert.equal(result.context, 'session');
    assert.equal(request.system, undefined);
    assert.equal(request.tools, undefined);
    assert.match(request.messages.at(-1).content[0].text, /Current side question/);
    assert.match(request.messages.at(-1).content[0].text, /Earlier side questions/);
    assert.ok(events.some((event) => event.phase === 'delta' && event.text === 'side '));
    assert.ok(events.some((event) => event.phase === 'done' && event.answer === 'side answer'));
  }, { fixture });
});

test('btw.cancel aborts an in-flight side question', async () => {
  const fixture = withBtwRoute();
  let received = null;
  fixture.services.llm = {
    async *stream(options) {
      received = options;
      await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  await withAttachHost(async ({ client }) => {
    await client.request('session.open', { sessionId: 's1' });
    const pending = client.request('btw.ask', { question: 'slow?', requestId: 'r2' });
    for (let attempt = 0; attempt < 50 && received === null; attempt += 1) await wait(10);
    assert.ok(received, 'the side request reached the model');
    const cancelled = await client.request('btw.cancel', { requestId: 'r2' });
    assert.deepEqual(cancelled, { cancelled: true });
    const result = await pending;
    assert.deepEqual(result, { cancelled: true, requestId: 'r2' });
  }, { fixture });
});

test('btw.fork starts a caller-delivered fork subagent and reports its result', async () => {
  const fixture = withBtwRoute();
  let spec;
  const result = Promise.withResolvers();
  fixture.services.subagents.startActivation = async (request) => {
    spec = request;
    return {
      childId: 'child-btw',
      name: 'btw-1',
      result: result.promise,
      dispose: async () => {},
    };
  };
  await withAttachHost(async ({ client }) => {
    await client.request('session.open', { sessionId: 's1' });
    const events = [];
    client.on('btw', (message) => events.push(message));
    const value = await client.request('btw.fork', {
      question: 'where?',
      answer: 'there',
      requestId: 'r3',
    });
    assert.equal(value.supported, true);
    assert.equal(value.childId, 'child-btw');
    assert.equal(spec.provider, 'fork');
    assert.equal(spec.delivery, 'caller');
    assert.equal(spec.parent, fixture.agent);
    assert.match(spec.prompt[0].text, /Question: where\?/);
    assert.match(spec.prompt[0].text, /Side answer/);
    result.resolve({ output: [{ type: 'text', text: 'verified' }], stopReason: 'completed' });
    for (let attempt = 0; attempt < 50 && !events.some((event) => event.phase === 'fork-done'); attempt += 1) await wait(10);
    const done = events.find((event) => event.phase === 'fork-done');
    assert.equal(done.childId, 'child-btw');
    assert.equal(done.output, 'verified');
  }, { fixture });
});

test('btw.fork reports unsupported when the Host has no activation API', async () => {
  const fixture = withBtwRoute();
  await withAttachHost(async ({ client }) => {
    await client.request('session.open', { sessionId: 's1' });
    const value = await client.request('btw.fork', { question: 'where?', answer: 'there' });
    assert.equal(value.supported, false);
    assert.match(value.reason, /background subagents/u);
  }, { fixture });
});
