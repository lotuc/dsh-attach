/**
 * Client-side view of the durable `inbox` projection.
 *
 * The projection stores every pending message in two lists. Injected runtime
 * context shares the list with user prompts, so callers must not filter before
 * applying a splice: the event's indexes refer to the complete list.
 */

const TARGET_KEYS = new Map([
  ['next-turn', 'nextTurn'],
  ['next-step', 'nextStep'],
]);

/** @returns {{nextTurn: object[], nextStep: object[]}} */
export function emptyInbox() {
  return { nextTurn: [], nextStep: [] };
}

function messageList(value) {
  return Array.isArray(value) ? value.filter((message) => message !== null && typeof message === 'object') : [];
}

/**
 * Normalize the projection payload (`next-turn` / `next-step` keys) or an
 * already-normalized inbox.
 * @param {unknown} value
 * @returns {{nextTurn: object[], nextStep: object[]}}
 */
export function normalizeInbox(value) {
  const source = value !== null && typeof value === 'object' ? value : {};
  return {
    nextTurn: messageList(source['next-turn'] ?? source.nextTurn),
    nextStep: messageList(source['next-step'] ?? source.nextStep),
  };
}

/**
 * Apply one durable `agent/inbox/spliced` event.
 * @param {{nextTurn: object[], nextStep: object[]}} inbox
 * @param {{target?: string, start?: number, removedCount?: number, inserted?: object[], outcome?: string}} data
 * @returns {{inbox: {nextTurn: object[], nextStep: object[]}, removed: object[], inserted: object[]}}
 */
export function applyInboxSplice(inbox, data) {
  const key = TARGET_KEYS.get(data?.target);
  if (key === undefined) return { inbox, removed: [], inserted: [] };
  const list = Array.isArray(inbox?.[key]) ? inbox[key] : [];
  const start = Number(data.start);
  const removedCount = data.removedCount === undefined ? 0 : Number(data.removedCount);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(removedCount) || removedCount < 0) {
    return { inbox, removed: [], inserted: [] };
  }
  const boundedStart = Math.min(start, list.length);
  const boundedRemoved = Math.min(removedCount, list.length - boundedStart);
  const inserted = messageList(data.inserted);
  const removed = list.slice(boundedStart, boundedStart + boundedRemoved);
  return {
    inbox: { ...inbox, [key]: list.toSpliced(boundedStart, boundedRemoved, ...inserted) },
    removed,
    inserted,
  };
}

/**
 * Remove a claimed message by identity. The id is the only stable match when
 * the same text is queued more than once.
 * @param {{nextTurn: object[], nextStep: object[]}} inbox
 * @param {{id?: unknown}} message
 * @returns {{nextTurn: object[], nextStep: object[]}}
 */
export function removeInboxMessage(inbox, message) {
  const id = typeof message?.id === 'string' ? message.id : null;
  if (id === null) return inbox;
  const inTurn = inbox.nextTurn.some((entry) => entry?.id === id);
  const inStep = inbox.nextStep.some((entry) => entry?.id === id);
  if (!inTurn && !inStep) return inbox;
  return {
    nextTurn: inTurn ? inbox.nextTurn.filter((entry) => entry?.id !== id) : inbox.nextTurn,
    nextStep: inStep ? inbox.nextStep.filter((entry) => entry?.id !== id) : inbox.nextStep,
  };
}

/**
 * Remove the first pending message whose text matches. Used as a fallback for
 * Hosts that omit `user/message` ids.
 * @param {{nextTurn: object[], nextStep: object[]}} inbox
 * @param {string} text
 * @param {(message: object) => string} textOf
 * @returns {{nextTurn: object[], nextStep: object[]}}
 */
export function removeInboxMessageByText(inbox, text, textOf) {
  if (text === '') return inbox;
  for (const key of ['nextTurn', 'nextStep']) {
    const index = inbox[key].findIndex((entry) => textOf(entry) === text);
    if (index >= 0) {
      return { ...inbox, [key]: inbox[key].toSpliced(index, 1) };
    }
  }
  return inbox;
}

function visible(message) {
  const kind = message?.source?.kind;
  return kind === undefined || kind === 'user' || kind === 'user-question-reply';
}

/**
 * User-visible pending messages, with the destination label used by the
 * queue panel. Injected runtime context is excluded from display.
 * @param {{nextTurn: object[], nextStep: object[]}} inbox
 * @returns {{target: 'next-turn'|'next-step', label: string, message: object}[]}
 */
export function visibleInboxEntries(inbox) {
  const entries = [];
  for (const [target, label] of [['next-turn', 'next turn'], ['next-step', 'next step']]) {
    const key = target === 'next-turn' ? 'nextTurn' : 'nextStep';
    for (const message of inbox?.[key] ?? []) {
      if (visible(message)) entries.push({ target, label, message });
    }
  }
  return entries;
}
