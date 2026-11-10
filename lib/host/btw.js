/**
 * One detached side question for the terminal `/btw` command.
 *
 * The request is intentionally outside the session turn: it does not enqueue a
 * prompt, does not write to the session log, and never exposes tools. It borrows
 * the conversation's completed messages and the session's current model route
 * so an aside can answer questions about work already discussed.
 */
const MAX_CONTEXT_CHARS = 24_000;
const MAX_TOOL_RESULT_CHARS = 1_200;
export const BTW_TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT = `SIDE_QUESTION_POLICY
You are the same assistant that is working in this conversation, answering one side question the user asked while the main task continues.

The answer appears in a small side panel. It is not part of the main conversation and it changes nothing about the main task.

Answer only what was asked, in the user's language. Open with the answer itself, then at most a few sentences of necessary detail. When the transcript already establishes the fact, rely on it; when it does not, say plainly that you cannot verify it from this conversation instead of guessing.

You have no tools in this request. Do not continue the main task, do not propose or describe edits as if you had made them, do not run or claim to have run anything, and do not ask clarifying questions unless the question is genuinely ambiguous.`;

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
 * Flatten completed session messages into a bounded text-only transcript.
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

/** Prefer the full log so /btw does not lose facts removed by compaction. */
export function sideQuestionMessages(session) {
  if (typeof session?.snapshotEvents === 'function') {
    try {
      return sessionEventMessages(session.snapshotEvents());
    } catch {
      // Fall through to the model-visible history when the log cannot be read.
    }
  }
  return typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [];
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

/** Ask the session's own model one side question with no tools. */
export async function askBtw(ctx, agent, question, { timeoutMs = BTW_TIMEOUT_MS } = {}) {
  const text = String(question ?? '').trim();
  if (text === '') throw new Error('question is required');
  const llm = ctx.get('llm');
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new Error('the LLM service is not mounted in this profile');
  }
  const route = resolveBtwRoute(ctx, agent);
  const transcript = buildBtwTranscript(sideQuestionMessages(agent?.session));
  const messages = btwRequestMessages(transcript.entries, route, transcript.omitted);
  messages.push({ role: 'user', content: [{ type: 'text', text: text }] });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('side question timed out')), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    const answer = await readAnswer(llm.stream({
      provider: route.provider,
      model: route.model,
      system: SYSTEM_PROMPT,
      messages,
      temperature: 0.2,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      ...(agent?.id === undefined ? {} : { sessionId: agent.id }),
      signal: controller.signal,
    }));
    return { ...answer, provider: route.provider, model: route.model };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

async function readAnswer(stream) {
  let answer = '';
  let reasoning = '';
  let finish;
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') answer += chunk.text;
    else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text;
    else if (chunk?.type === 'finish') finish = chunk.reason;
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    throw new Error(`${finish.failure?.code ?? finish.kind}: ${finish.failure?.message ?? 'the model request failed'}`);
  }
  if (answer.trim() === '') throw new Error('the model returned no answer text');
  return { answer: answer.trim(), reasoning: reasoning.trim() };
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
  const total = entries.reduce((sum, entry) => sum + Array.from(entry.text).length, 0);
  if (total <= budget) return { entries, omitted: 0 };
  const head = entries[0];
  const tail = [];
  let used = Array.from(head.text).length;
  for (let index = entries.length - 1; index >= 1; index -= 1) {
    const cost = Array.from(entries[index].text).length + 2;
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

function safeCall(callback) {
  try {
    return callback();
  } catch {
    return undefined;
  }
}
