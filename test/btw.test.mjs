import assert from 'node:assert/strict';
import test from 'node:test';

import {
  askBtw,
  buildBtwMessages,
  buildBtwTranscript,
  btwRequestMessages,
  normalizeBtwHistory,
  resolveBtwRoute,
  sessionEventMessages,
  sideQuestionMessages,
} from '../lib/host/btw.js';

function sessionWith(deriveMessages, extra = {}) {
  return {
    deriveMessages,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    ...extra,
  };
}

function routeContext(stream, overrides = {}) {
  return {
    get(name) {
      if (name === 'llm') return { stream };
      return undefined;
    },
    ...overrides,
  };
}

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

test('normalizes bounded side-thread history', () => {
  const input = [];
  for (let i = 0; i < 25; i += 1) input.push({ question: `q${i}`, answer: `a${i}` });
  input.push({ question: '', answer: 'empty' });
  input.push({ question: 'drop', answer: '' });
  const history = normalizeBtwHistory(input);
  assert.equal(history.length, 20);
  assert.equal(history[0].question, 'q5');
  assert.equal(history.at(-1).question, 'q24');
  assert.equal(normalizeBtwHistory([{ question: 'q', answer: 'x'.repeat(30_000) }])[0].answer.endsWith('…'), true);
});

test('appends one side boundary after the exact model-visible history', () => {
  const base = [
    { role: 'system', content: [{ type: 'text', text: 'PROJECT_RULES' }] },
    { role: 'user', content: [{ type: 'text', text: 'main task' }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'tool output' }] },
  ];
  const messages = buildBtwMessages(base, [{ question: 'q1', answer: 'a1' }], 'q2');
  assert.equal(messages.length, base.length + 1);
  assert.equal(messages[0], base[0]);
  assert.equal(messages[1], base[1]);
  const block = messages.at(-1);
  assert.equal(block.role, 'user');
  assert.match(block.content[0].text, /SIDE_QUESTION_POLICY/);
  assert.match(block.content[0].text, /Q: q1\nA: a1/);
  assert.match(block.content[0].text, /Current side question\]\n\nq2/);
  assert.equal(base.length, 3, 'the source history is not mutated');
});

test('asks with the session context prefix, no system override, no tools, and streaming deltas', async () => {
  let request;
  const deltas = [];
  const stream = async function* stream(options) {
    request = options;
    yield { type: 'reasoning-delta', text: 'think' };
    yield { type: 'text-delta', text: 'answer' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const ctx = routeContext(stream);
  const base = [
    { role: 'system', content: [{ type: 'text', text: 'PROJECT_RULES' }] },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  ];
  const agent = { id: 's1', session: sessionWith(() => base) };
  const result = await askBtw(ctx, agent, 'why?', {
    history: [{ question: 'earlier', answer: 'old answer' }],
    onDelta: (delta) => deltas.push(delta),
  });
  assert.equal(result.answer, 'answer');
  assert.equal(result.reasoning, 'think');
  assert.equal(result.provider, 'p');
  assert.equal(result.model, 'm');
  assert.equal(result.context, 'session');
  assert.equal(request.provider, 'p');
  assert.equal(request.tools, undefined);
  assert.equal(request.system, undefined, 'the main system message must stay in messages');
  assert.equal(request.messages[0], base[0]);
  assert.match(request.messages.at(-1).content[0].text, /SIDE_QUESTION_POLICY/);
  assert.match(request.messages.at(-1).content[0].text, /Current side question\]\n\nwhy\?/);
  assert.deepEqual(deltas, [{ reasoning: 'think' }, { text: 'answer' }]);
});

test('falls back to the raw log when the session cannot derive model-visible messages', async () => {
  let request;
  const stream = async function* stream(options) {
    request = options;
    yield { type: 'text-delta', text: 'fallback answer' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const session = sessionWith(
    () => [],
    {
      snapshotEvents: () => [
        { type: 'user/message', data: { content: [{ type: 'text', text: 'raw task' }] } },
        { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'raw answer' }] } } },
      ],
    },
  );
  const result = await askBtw(routeContext(stream), { id: 's1', session }, 'what?');
  assert.equal(result.context, 'transcript');
  assert.equal(request.system, undefined);
  assert.equal(request.messages[0].role, 'user');
  assert.match(request.messages[0].content[0].text, /raw task/);
  assert.match(request.messages.at(-1).content[0].text, /what\?/);
});

test('adds an explicit note when the side model tries to call a tool', async () => {
  const stream = async function* stream() {
    yield { type: 'text-delta', text: 'I would read the file.' };
    yield { type: 'tool-call-delta', id: 'c1', name: 'read', argumentsDelta: '{}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const agent = { id: 's1', session: sessionWith(() => [{ role: 'user', content: [{ type: 'text', text: 'x' }] }]) };
  const result = await askBtw(routeContext(stream), agent, 'where?');
  assert.equal(result.toolAttempted, true);
  assert.match(result.answer, /No tools were executed/);
});

test('reports cancellation through a stable attach code', async () => {
  const controller = new AbortController();
  controller.abort();
  const stream = async function* stream(options) {
    if (options.signal.aborted) throw new Error('aborted');
    yield { type: 'text-delta', text: 'never' };
  };
  const agent = { id: 's1', session: sessionWith(() => [{ role: 'user', content: [{ type: 'text', text: 'x' }] }]) };
  await assert.rejects(
    askBtw(routeContext(stream), agent, 'where?', { signal: controller.signal }),
    (error) => error.code === 'attach/cancelled',
  );
});

test('reconstructs the full conversation from raw session events', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'old task' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } } },
    { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'tool text' }] } } },
    { type: 'command/run', data: { command: '/btw' } },
  ];
  const messages = sessionEventMessages(events);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[2].role, 'tool');
});

test('raw fallback reconstruction stays available', () => {
  const session = {
    snapshotEvents: () => [{ type: 'user/message', data: { content: [{ type: 'text', text: 'raw' }] } }],
    deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'summary' }] }],
  };
  assert.equal(sideQuestionMessages(session)[0].content[0].text, 'raw');
  const messages = btwRequestMessages([{ role: 'user', text: 'raw' }], { provider: 'p', model: 'm' });
  assert.equal(messages[0].content[0].text, 'raw');
});

test('strips leaked DSML tool-call markup from the answer and the stream', async () => {
  const markup = [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="bash">',
    '<｜｜DSML｜｜ parameter name="command" string="true">sed -n \'1,95p\' docs/keybindings.md</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>',
  ].join('\n');
  const deltas = [];
  const stream = async function* stream() {
    yield { type: 'text-delta', text: 'I cannot read files here. ' };
    yield { type: 'text-delta', text: markup.slice(0, 17) };
    yield { type: 'text-delta', text: markup.slice(17) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const agent = { id: 's1', session: sessionWith(() => [{ role: 'user', content: [{ type: 'text', text: 'x' }] }]) };
  const result = await askBtw(routeContext(stream), agent, 'what is in the docs?', {
    onDelta: (delta) => deltas.push(delta.text ?? ''),
  });
  assert.equal(result.toolAttempted, true);
  assert.doesNotMatch(result.answer, /DSML|invoke|parameter/u);
  assert.match(result.answer, /I cannot read files here\./u);
  assert.match(result.answer, /No tools were executed/u);
  assert.doesNotMatch(deltas.join(''), /DSML|invoke|parameter/u);
});

test('replaces a tool-call-only leaked answer with a clear no-tools message', async () => {
  const markup = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="bash"></｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
  const stream = async function* stream() {
    yield { type: 'text-delta', text: markup };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const agent = { id: 's1', session: sessionWith(() => [{ role: 'user', content: [{ type: 'text', text: 'x' }] }]) };
  const result = await askBtw(routeContext(stream), agent, 'run this');
  assert.equal(result.toolAttempted, true);
  assert.match(result.answer, /no tool access/u);
  assert.doesNotMatch(result.answer, /DSML/u);
});
