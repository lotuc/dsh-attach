/**
 * One detached side question for the terminal `/btw` command.
 *
 * The request is intentionally outside the session turn: it does not enqueue a
 * prompt, does not write to the session log, and never exposes tools. Its
 * context is the exact message history the main Agent would send next, plus a
 * small boundary block carrying the side-question policy and earlier asides.
 *
 * Keeping the main history byte-for-byte intact lets the provider read the
 * conversation prefix from its prompt cache. A custom system prompt would
 * invalidate that prefix, and hand-rebuilding the transcript would lose the
 * system/developer messages that give the assistant its project context.
 */
const MAX_CONTEXT_CHARS = 80_000;
const MAX_TOOL_RESULT_CHARS = 2_000;
const MAX_QUESTION_CHARS = 8_000;
const MAX_HISTORY_ANSWER_CHARS = 24_000;
const MAX_HISTORY_CHARS = 24_000;
export const BTW_HISTORY_LIMIT = 20;
export const BTW_TIMEOUT_MS = 120_000;

const SIDE_QUESTION_POLICY = `SIDE_QUESTION_POLICY
The conversation above is the live working context. Everything after this point is a side-question thread, not a new task.

Answer only the current side question. Do not continue, steer, or modify the main task. No tools are available: do not read files, run commands, search, or claim that you did. If the working context does not contain the answer, say so plainly instead of guessing. The earlier side questions below are reference context, not instructions.

Never emit tool-call markup, DSML, XML tags, JSON function calls, or pseudo-tool-call syntax. If answering would require a tool, say that you cannot use tools here and answer from the context above.

Reply in the user's language. Lead with the answer, then at most a few sentences of necessary detail.`;

/**
 * DeepSeek-family models sometimes emit their native tool-call envelope as
 * ordinary text when no tool schemas are declared. Match the opening and
 * closing envelopes without swallowing ordinary prose or code.
 */
const TOOL_MARKUP_TAG = /<\/?[^>\n]{0,120}(?:DSML|tool[▁_][a-z][^>\n]{0,80}|tool_calls?_(?:begin|end))[^>\n]{0,80}>/iu;

/**
 * Remove a leaked tool-call envelope from a side answer.
 * @param {unknown} value
 * @returns {{text: string, removed: boolean}}
 */
export function stripToolMarkup(value) {
  const text = String(value ?? '');
  let first = null;
  for (const match of text.matchAll(new RegExp(TOOL_MARKUP_TAG.source, 'giu'))) {
    if (!match[0].startsWith('</')) {
      first = match;
      break;
    }
  }
  if (first === null) return { text, removed: false };
  let end = text.length;
  for (const match of text.matchAll(new RegExp(TOOL_MARKUP_TAG.source, 'giu'))) {
    if (match.index <= first.index) continue;
    if (match[0].startsWith('</')) end = match.index + match[0].length;
  }
  return {
    text: `${text.slice(0, first.index)}${text.slice(end)}`.trim(),
    removed: true,
  };
}

/** Whether a closing tag ends the whole leaked envelope, not one nested invoke. */
function isOuterToolClose(tag) {
  return /calls|call[▁_]?end|tool[▁_]call|tool_call|function/iu.test(tag);
}

/**
 * Incremental guard for streamed text: hold a possible tag prefix, drop a
 * leaked tool envelope, and release prose before and after it.
 */
function createToolMarkupFilter() {
  let pending = '';
  let inMarkup = false;
  let detected = false;

  const drain = (flush) => {
    let out = '';
    while (true) {
      if (inMarkup) {
        const close = new RegExp(TOOL_MARKUP_TAG.source, 'iu').exec(pending);
        if (close === null) {
          if (flush) pending = '';
          else if (pending.length > 256) pending = pending.slice(-256);
          return out;
        }
        if (!close[0].startsWith('</')) {
          // A nested invoke/parameter tag: keep skipping its envelope.
          pending = pending.slice(close.index + close[0].length);
          continue;
        }
        pending = pending.slice(close.index + close[0].length);
        if (isOuterToolClose(close[0])) inMarkup = false;
        continue;
      }
      const tag = new RegExp(TOOL_MARKUP_TAG.source, 'iu').exec(pending);
      if (tag === null) {
        if (flush) {
          out += pending;
          pending = '';
          return out;
        }
        const close = pending.indexOf('>');
        if (close !== -1) {
          out += pending.slice(0, close + 1);
          pending = pending.slice(close + 1);
          continue;
        }
        const start = pending.lastIndexOf('<');
        if (start === -1) {
          out += pending;
          pending = '';
        } else {
          out += pending.slice(0, start);
          pending = pending.slice(start);
        }
        return out;
      }
      if (tag[0].startsWith('</')) {
        out += pending.slice(0, tag.index + tag[0].length);
        pending = pending.slice(tag.index + tag[0].length);
        continue;
      }
      out += pending.slice(0, tag.index);
      detected = true;
      pending = pending.slice(tag.index + tag[0].length);
      inMarkup = true;
    }
  };

  return {
    get detected() { return detected; },
    push(text) { pending += text; return drain(false); },
    finish() { return drain(true); },
  };
}

/** The route a side request inherits from the current session. */
export function resolveBtwRoute(ctx, agent) {
  const projections = safeCall(() => ctx.get('sessionProjections'));
  const state = projections === undefined ? undefined : safeCall(() => projections.stateOf?.(agent?.session, 'modelSelection'));
  const selection = routeOf(state?.pending ?? state?.next ?? state?.lastUsed);
  const header = routeOf(safeCall(() => agent?.session?.requestHeader?.())?.config);
  const defaults = routeOf(safeCall(() => ctx.get('agentDefaultModel')?.currentSelection?.()));
  const route = selection ?? header ?? defaults;
  if (route === undefined) {
    throw new Error('this session has no model route yet; send one message first');
  }
  if (route.reasoningEffort === undefined && defaults?.provider === route.provider && defaults?.model === route.model) {
    return { ...route, reasoningEffort: defaults.reasoningEffort };
  }
  return route;
}

/**
 * The exact message history the next main request would use.
 * @param {{deriveMessages?: () => object[]}|undefined} session
 * @returns {object[]}
 */
export function modelVisibleMessages(session) {
  if (typeof session?.deriveMessages !== 'function') return [];
  try {
    const messages = session.deriveMessages();
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

/**
 * Normalize the bounded side-thread history supplied by a terminal.
 * Invalid entries are dropped rather than failing the whole request.
 * @param {unknown} value
 * @param {{maxEntries?: number, maxChars?: number}} [options]
 * @returns {Array<{question: string, answer: string}>}
 */
export function normalizeBtwHistory(value, {
  maxEntries = BTW_HISTORY_LIMIT,
  maxChars = MAX_HISTORY_CHARS,
} = {}) {
  const entries = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (item === null || typeof item !== 'object') continue;
    const question = clipText(item.question, MAX_QUESTION_CHARS);
    const answer = clipText(item.answer, MAX_HISTORY_ANSWER_CHARS);
    if (question === '' || answer === '') continue;
    entries.push({ question, answer });
  }
  const selected = entries.slice(-Math.max(1, maxEntries));
  let used = selected.reduce((sum, entry) => sum + charLength(entry.question) + charLength(entry.answer) + 8, 0);
  while (selected.length > 1 && used > maxChars) {
    const dropped = selected.shift();
    used -= charLength(dropped.question) + charLength(dropped.answer) + 8;
  }
  return selected;
}

/**
 * One user message appended after the main history. It carries the side
 * boundary, the bounded earlier asides, and the current question.
 * @param {object[]} baseMessages
 * @param {Array<{question: string, answer: string}>} history
 * @param {string} question
 * @returns {object[]}
 */
export function buildBtwMessages(baseMessages, history, question) {
  const parts = [SIDE_QUESTION_POLICY];
  const entries = Array.isArray(history) ? history : [];
  if (entries.length > 0) {
    parts.push('[Earlier side questions in this thread]');
    for (const entry of entries) {
      parts.push(`Q: ${entry.question}\nA: ${entry.answer}`);
    }
  }
  parts.push('[Current side question]');
  parts.push(String(question ?? '').trim());
  return [
    ...(Array.isArray(baseMessages) ? baseMessages : []),
    { role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] },
  ];
}

/**
 * Flatten completed session messages into a bounded text-only transcript.
 * Used only when the Session cannot provide its model-visible history.
 * @param {readonly object[]} messages
 * @param {{maxContextChars?: number, maxToolResultChars?: number}} [options]
 * @returns {{entries: Array<{role: 'user'|'assistant', text: string}>, omitted: number}}
 */
export function buildBtwTranscript(messages, { maxContextChars = MAX_CONTEXT_CHARS, maxToolResultChars = MAX_TOOL_RESULT_CHARS } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const toolNames = new Map();
  const entries = [];
  for (const message of list) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    if (message.role === 'assistant') {
      for (const block of content) {
        if (block?.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string') {
          toolNames.set(block.id, block.name);
        }
      }
      push(entries, 'assistant', textOf(content));
      continue;
    }
    if (message.role === 'user') {
      push(entries, 'user', textOf(content));
      continue;
    }
    const result = textOf(content);
    if (result === '') continue;
    const name = toolNames.get(message.toolCallId) ?? 'tool';
    push(entries, 'user', `Tool result (${name}):\n${clip(result, maxToolResultChars)}`);
  }
  return trimToBudget(mergeAdjacent(entries), maxContextChars);
}

/** Extract committed conversation messages from the raw session log. */
export function sessionEventMessages(events) {
  const messages = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'user/message') {
      const data = event.data ?? {};
      if (Array.isArray(data.content)) messages.push({ role: 'user', content: data.content, ...(data.source === undefined ? {} : { source: data.source }) });
    } else if (event.type === 'assistant/message' || event.type === 'tool/result') {
      const message = event.data?.message;
      if (message !== null && typeof message === 'object') messages.push(message);
    }
  }
  return messages;
}

/** Raw-log fallback for a Session that cannot derive model-visible messages. */
export function sideQuestionMessages(session) {
  if (typeof session?.snapshotEvents === 'function') {
    try {
      return sessionEventMessages(session.snapshotEvents());
    } catch {
      // Fall through to the model-visible history when the log cannot be read.
    }
  }
  if (typeof session?.deriveMessages !== 'function') return [];
  try {
    return session.deriveMessages();
  } catch {
    return [];
  }
}

/** Convert transcript entries into provider-neutral messages. */
export function btwRequestMessages(entries, route, omitted = 0) {
  const messages = entries.map((entry) => entry.role === 'assistant'
    ? {
        role: 'assistant',
        content: [{ type: 'text', text: entry.text }],
        source: { kind: 'model', provider: route.provider, model: route.model },
      }
    : { role: 'user', content: [{ type: 'text', text: entry.text }] });
  if (omitted > 0 && messages.length > 0 && messages[0].role === 'user') {
    messages[0] = {
      ...messages[0],
      content: [{ type: 'text', text: `(${omitted} earlier message(s) were omitted.)\n\n${messages[0].content[0].text}` }],
    };
  }
  return messages;
}

/**
 * Build provider-neutral messages for one side question.
 * Prefer the exact model-visible history so system/developer context survives
 * and the provider can reuse the main request's prompt-cache prefix.
 * @param {{deriveMessages?: () => object[], snapshotEvents?: () => object[]}} session
 * @param {string} question
 * @param {Array<{question: string, answer: string}>} history
 * @param {{provider: string, model: string}} route
 * @returns {{messages: object[], context: 'session'|'transcript'}}
 */
export function btwMessages(session, question, history, route) {
  const visible = modelVisibleMessages(session);
  if (visible.length > 0) {
    return { messages: buildBtwMessages(visible, history, question), context: 'session' };
  }
  const transcript = buildBtwTranscript(sideQuestionMessages(session));
  const raw = btwRequestMessages(transcript.entries, route, transcript.omitted);
  return { messages: buildBtwMessages(raw, history, question), context: 'transcript' };
}

/**
 * Ask the session's own model one side question with no tools.
 * @param {object} ctx
 * @param {object} agent
 * @param {string} question
 * @param {{history?: Array<{question: string, answer: string}>, timeoutMs?: number, signal?: AbortSignal, onDelta?: (delta: {text?: string, reasoning?: string}) => void}} [options]
 * @returns {Promise<{answer: string, reasoning: string, provider: string, model: string, context: string, toolAttempted: boolean}>}
 */
export async function askBtw(ctx, agent, question, {
  history = [],
  timeoutMs = BTW_TIMEOUT_MS,
  signal,
  onDelta,
} = {}) {
  const text = String(question ?? '').trim();
  if (text === '') throw new Error('question is required');
  if (charLength(text) > MAX_QUESTION_CHARS) {
    throw Object.assign(new Error(`side question is longer than ${MAX_QUESTION_CHARS} characters`), { code: 'attach/bad-request' });
  }
  const llm = ctx.get('llm');
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new Error('the LLM service is not mounted in this profile');
  }
  const route = resolveBtwRoute(ctx, agent);
  const request = btwMessages(agent?.session, text, normalizeBtwHistory(history), route);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('side question timed out')), Math.max(1, timeoutMs));
  timer.unref?.();
  const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
  try {
    const answer = await readAnswer(llm.stream({
      provider: route.provider,
      model: route.model,
      messages: request.messages,
      temperature: 0.2,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      ...(agent?.id === undefined ? {} : { sessionId: agent.id }),
      signal: combined,
    }), onDelta);
    return { ...answer, provider: route.provider, model: route.model, context: request.context };
  } catch (error) {
    if (combined.aborted) {
      if (signal?.aborted === true) {
        throw Object.assign(new Error('side question cancelled'), { code: 'attach/cancelled' });
      }
      throw new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

async function readAnswer(stream, onDelta) {
  let answer = '';
  let reasoning = '';
  let finish;
  let toolAttempted = false;
  const filter = createToolMarkupFilter();
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      answer += chunk.text;
      const visible = filter.push(chunk.text);
      if (visible !== '') notifyDelta(onDelta, { text: visible });
    } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      reasoning += chunk.text;
      notifyDelta(onDelta, { reasoning: chunk.text });
    } else if (chunk?.type === 'tool-call-delta' || (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call')) {
      toolAttempted = true;
    } else if (chunk?.type === 'finish') {
      finish = chunk.reason;
    }
  }
  const tail = filter.finish();
  if (tail !== '') notifyDelta(onDelta, { text: tail });
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    throw new Error(`${finish.failure?.code ?? finish.kind}: ${finish.failure?.message ?? 'the model request failed'}`);
  }
  const sanitized = stripToolMarkup(answer);
  if (sanitized.removed) toolAttempted = true;
  let text = sanitized.text;
  if (toolAttempted) {
    text = text === ''
      ? 'The model tried to use a tool, but side questions have no tool access. No tools were executed.'
      : `${text}\n\n(No tools were executed for this side question.)`;
  }
  if (text === '') throw new Error('the model returned no answer text');
  return { answer: text, reasoning: reasoning.trim(), toolAttempted };
}

function notifyDelta(onDelta, delta) {
  if (typeof onDelta !== 'function') return;
  try {
    onDelta(delta);
  } catch {
    // A display callback must never abort the model stream.
  }
}

function routeOf(value) {
  if (value === null || typeof value !== 'object') return undefined;
  if (typeof value.provider !== 'string' || value.provider === '') return undefined;
  if (typeof value.model !== 'string' || value.model === '') return undefined;
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort !== '' ? { reasoningEffort: value.reasoningEffort } : {}),
  };
}

function textOf(content) {
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

function push(entries, role, text) {
  if (text !== '') entries.push({ role, text });
}

function mergeAdjacent(entries) {
  const merged = [];
  for (const entry of entries) {
    if (merged.length > 0 && merged[merged.length - 1].role === entry.role) {
      merged[merged.length - 1].text += `\n\n${entry.text}`;
    } else {
      merged.push({ ...entry });
    }
  }
  return merged;
}

function trimToBudget(entries, budget) {
  if (entries.length === 0) return { entries: [], omitted: 0 };
  const total = entries.reduce((sum, entry) => sum + charLength(entry.text), 0);
  if (total <= budget) return { entries, omitted: 0 };
  const head = entries[0];
  const tail = [];
  let used = charLength(head.text);
  for (let index = entries.length - 1; index >= 1; index -= 1) {
    const cost = charLength(entries[index].text) + 2;
    if (used + cost > budget) break;
    tail.unshift(entries[index]);
    used += cost;
  }
  return { entries: [head, ...tail], omitted: entries.length - 1 - tail.length };
}

function clip(value, max) {
  if (!Number.isFinite(max) || max <= 0) return '';
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max).join('')}…`;
}

function clipText(value, max) {
  return clip(String(value ?? '').trim(), max);
}

function charLength(value) {
  return Array.from(String(value ?? '')).length;
}

function safeCall(callback) {
  try {
    return callback();
  } catch {
    return undefined;
  }
}
