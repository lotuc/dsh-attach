import assert from 'node:assert/strict';
import test from 'node:test';

let loadCount = 0;
async function loadClient() {
  const sources = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      sources.push(this);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    close() {
      this.closed = true;
    }

    emit(payload) {
      this.listeners.get('interaction')?.({ data: JSON.stringify(payload) });
    }
  }

  const effects = [];
  const answered = [];
  const aborted = [];
  let statusListener = null;
  let pendingInteraction = {
    kind: 'approval',
    callId: 'call-1',
    toolName: 'bash',
    answerable: true,
    answer: async (outcome) => { answered.push(outcome); },
    abort: (reason) => { aborted.push(reason); },
  };
  const ctx = {
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
    uiWorkspace: { openSession() {} },
    uiSession: {
      sessionStatus: {
        getSnapshot: () => new Map([['s1', { pendingInteraction }]]),
        subscribe(listener) {
          statusListener = listener;
          return () => { statusListener = null; };
        },
      },
    },
    effect(fn) {
      effects.push(fn());
    },
  };

  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const previousEventSource = globalThis.EventSource;
  let registration;
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        registration = value;
      },
    },
    setTimeout() { return 0; },
    clearTimeout() {},
    focus() {},
  };
  globalThis.fetch = async () => ({ ok: false });
  globalThis.EventSource = FakeEventSource;

  await import(`../client.js?approval-companion-test=${++loadCount}`);
  const module = registration.factory();
  module.apply(ctx);
  await Promise.resolve();

  return {
    sources,
    answered,
    aborted,
    setPending(value) {
      pendingInteraction = value;
      statusListener?.();
    },
    close() {
      for (const dispose of effects) {
        if (typeof dispose === 'function') dispose();
      }
      globalThis.window = previousWindow;
      globalThis.fetch = previousFetch;
      globalThis.EventSource = previousEventSource;
    },
  };
}

test('answers the native Web approval with the terminal outcome', async () => {
  const fixture = await loadClient();
  try {
    assert.equal(fixture.sources.length, 1);
    assert.equal(fixture.sources[0].url, '/dsh-attach/interactions');
    fixture.sources[0].emit({
      kind: 'approval',
      winner: 'terminal',
      sessionId: 's1',
      callId: 'call-1',
      toolName: 'bash',
      outcome: 'allowed-once',
    });
    await Promise.resolve();
    assert.deepEqual(fixture.answered, ['allowed-once']);
  } finally {
    fixture.close();
  }
});

test('ignores a Web win and mismatched call ids', async () => {
  const fixture = await loadClient();
  try {
    fixture.sources[0].emit({
      kind: 'approval',
      winner: 'web',
      sessionId: 's1',
      callId: 'call-1',
      outcome: 'rejected',
    });
    fixture.sources[0].emit({
      kind: 'approval',
      winner: 'terminal',
      sessionId: 's1',
      callId: 'other',
      outcome: 'rejected',
    });
    await Promise.resolve();
    assert.deepEqual(fixture.answered, []);
    assert.deepEqual(fixture.aborted, []);
  } finally {
    fixture.close();
  }
});

test('reconciles a settlement that arrives before the Web panel exists', async () => {
  const fixture = await loadClient();
  try {
    fixture.setPending(null);
    fixture.sources[0].emit({
      kind: 'approval',
      winner: 'terminal',
      sessionId: 's1',
      callId: 'call-1',
      toolName: 'bash',
      outcome: 'allowed-once',
    });
    await Promise.resolve();
    assert.deepEqual(fixture.answered, []);
    fixture.setPending({
      kind: 'approval',
      callId: 'call-1',
      toolName: 'bash',
      answerable: true,
      answer: async (outcome) => { fixture.answered.push(outcome); },
      abort: (reason) => { fixture.aborted.push(reason); },
    });
    await Promise.resolve();
    assert.deepEqual(fixture.answered, ['allowed-once']);
  } finally {
    fixture.close();
  }
});

test('aborts a panel when the settlement has no decision outcome', async () => {
  const fixture = await loadClient();
  try {
    fixture.sources[0].emit({
      kind: 'approval',
      winner: 'timeout',
      sessionId: 's1',
      callId: 'call-1',
      outcome: null,
    });
    await Promise.resolve();
    assert.deepEqual(fixture.aborted, ['answered elsewhere']);
  } finally {
    fixture.close();
  }
});
