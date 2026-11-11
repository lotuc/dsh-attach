import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { AttachApp } from '../lib/client/app.js';
import { UserRow } from '../lib/client/transcript.js';

class FakeTui {
  constructor(terminal) {
    this.terminal = terminal;
    this.overlays = [];
    this.layout = null;
    this.focus = null;
    this.stopped = false;
    this.inputListeners = [];
  }
  start() {}
  stop() { this.stopped = true; }
  requestRender() {}
  setLayoutRoot(layout) { this.layout = layout; }
  setFocus(component) { this.focus = component; }
  addInputListener(listener) { this.inputListeners.push(listener); }
  showOverlay(component, options) {
    const handle = { component, options, hidden: false, hide() { this.hidden = true; } };
    this.overlays.push(handle);
    return handle;
  }
}

class FakeClient extends EventEmitter {
  constructor({ capabilities = ['history.pagination'] } = {}) {
    super();
    this.host = { capabilities, pluginVersion: '2026.1111.2215' };
    this.closed = false;
    this.requests = [];
    this.historyPages = [];
    this.reconnects = 0;
  }
  async request(method, params = {}) {
    this.requests.push([method, params]);
    switch (method) {
      case 'session.list':
        return {
          items: [{
            sessionId: 's1',
            updatedAt: Date.now(),
            running: false,
            blank: false,
            cwd: '/tmp/work',
            agentAvailable: true,
            projections: { kind: 'sequenced', values: { title: 'History' } },
          }],
        };
      case 'session.open':
        return { sessionId: params.sessionId ?? 's1' };
      case 'commands.list':
        return { commands: [] };
      case 'subagent.list':
        return { supported: false, items: [] };
      case 'history.events': {
        const page = this.historyPages.shift();
        if (page === undefined) throw new Error('unexpected history request');
        return page;
      }
      default:
        return {};
    }
  }
  async activity() {}
  async reconnect() { this.reconnects += 1; }
  close() { this.closed = true; }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function message(seq, text) {
  return {
    type: 'event',
    event: {
      type: 'user/message',
      seq,
      time: 1_000 + seq,
      data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
    },
  };
}

function userTexts(app) {
  return app.rows.filter((row) => row instanceof UserRow).map((row) => row.text);
}

async function runApp(t, client, options = {}) {
  const previous = process.env.DSH_ATTACH_NO_MOUSE;
  process.env.DSH_ATTACH_NO_MOUSE = '1';
  const terminal = { columns: 80, rows: 24 };
  const tui = new FakeTui(terminal);
  const app = new AttachApp(client, { session: 's1', logPath: 'off', terminal, tui, ...options });
  const running = app.run();
  t.after(async () => {
    app.quit('test');
    await running;
    if (previous === undefined) delete process.env.DSH_ATTACH_NO_MOUSE;
    else process.env.DSH_ATTACH_NO_MOUSE = previous;
  });
  for (let attempt = 0; attempt < 100 && app.state.sessionId !== 's1'; attempt += 1) await wait(5);
  assert.equal(app.state.sessionId, 's1');
  return { app, tui };
}

function emitSnapshot(client, records, hasMore = false) {
  client.emit('frame', {
    sessionId: 's1',
    frame: {
      type: 'snapshot',
      header: { cwd: '/tmp/work' },
      cursor: records.length === 0 ? -1 : records[records.length - 1].event.seq,
      hasMore,
      projections: { asOfSeq: records.length === 0 ? -1 : records[records.length - 1].event.seq, values: { title: 'History' } },
      records,
    },
  });
}

test('loads an older page ahead of the snapshot without duplicating live events', async (t) => {
  const client = new FakeClient();
  const { app } = await runApp(t, client);
  emitSnapshot(client, [message(10, 'newer one'), message(11, 'newer two')], true);
  client.emit('frame', { sessionId: 's1', frame: { type: 'event', event: message(12, 'live tail').event } });

  assert.equal(app.historyHasMore, true);
  assert.equal(app.historyOldestSeq, 10);
  assert.equal(app.historyFirstRenderedSeq, 10);
  assert.equal(app.historyNextBeforeSeq, 10);
  assert.deepEqual(userTexts(app), ['newer one', 'newer two', 'live tail']);

  client.historyPages.push({
    cursor: 12,
    hasMore: false,
    records: [
      message(9, 'older nine'),
      message(8, 'older eight'),
      message(12, 'live tail'),
      message(8, 'older eight'),
    ],
  });
  app.editor.setText('/history');
  app.editor.handleInput('\r');
  await wait(30);

  const request = client.requests.find(([method]) => method === 'history.events');
  assert.deepEqual(request[1], { beforeSeq: 10 });
  assert.deepEqual(userTexts(app), ['older eight', 'older nine', 'newer one', 'newer two', 'live tail']);
  assert.equal(app.historyHasMore, false);
  assert.equal(app.historyLoadedPages, 1);
  assert.equal(app.historyFirstRenderedSeq, 8);
  assert.equal(app.historyNextBeforeSeq, 8);
  assert.equal(app.activity.render(160).includes('earlier history not loaded'), false);

  app.editor.setText('/find older eight');
  app.editor.handleInput('\r');
  await wait(20);
  assert.ok(app.rows.some((row) => String(row.text ?? '').includes('match ·')), 'search sees the older page');
});

test('ctrl+r pages backwards by the oldest rendered sequence', async (t) => {
  const client = new FakeClient();
  const { app, tui } = await runApp(t, client);
  emitSnapshot(client, [message(20, 'snapshot')], true);

  client.historyPages.push({
    cursor: 21,
    hasMore: true,
    records: [message(16, 'page one'), message(15, 'page one oldest')],
  });
  client.historyPages.push({
    cursor: 21,
    hasMore: false,
    records: [message(15, 'page one oldest'), message(13, 'page two'), message(12, 'page two oldest')],
  });
  const input = tui.inputListeners[0];
  input('\x12');
  await wait(30);
  assert.equal(client.requests.filter(([method]) => method === 'history.events').length, 1);
  assert.deepEqual(client.requests.find(([method]) => method === 'history.events')[1], { beforeSeq: 20 });
  assert.equal(app.historyHasMore, true);
  assert.equal(app.historyFirstRenderedSeq, 15);
  assert.equal(app.historyNextBeforeSeq, 15);

  input('\x12');
  await wait(30);
  const requests = client.requests.filter(([method]) => method === 'history.events');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1][1], { beforeSeq: 15 });
  assert.equal(app.historyHasMore, false);
  assert.equal(app.historyLoadedPages, 2);
  assert.deepEqual(userTexts(app), [
    'page two oldest',
    'page two',
    'page one oldest',
    'page one',
    'snapshot',
  ]);
});

test('keeps the reader anchored when older rows are prepended', async (t) => {
  const client = new FakeClient();
  const { app } = await runApp(t, client);
  emitSnapshot(client, [message(20, 'snapshot')], true);
  app.transcript.updateLayout(1_000, 20, () => {});
  app.transcript.scrollTo(100, { disableFollow: true });
  assert.equal(app.transcript.isFollowingEnd, false);

  const scrollCalls = [];
  const scrollTo = app.transcript.scrollTo.bind(app.transcript);
  app.transcript.scrollTo = (top, options) => {
    scrollCalls.push({ top, options });
    scrollTo(top, options);
  };
  client.historyPages.push({
    cursor: 21,
    hasMore: false,
    records: Array.from({ length: 6 }, (_, index) => message(10 + index, `older ${index}`)),
  });
  app.editor.setText('/history');
  app.editor.handleInput('\r');
  await wait(60);

  assert.ok(scrollCalls.length > 0, 'prepending repositions the viewport');
  assert.ok(scrollCalls.some((call) => call.top > 100), 'the target moves past the added rows');
  assert.ok(scrollCalls.some((call) => call.options?.disableFollow === true), 'paging does not re-enable follow');
});

test('reconnect resets the history window from the new snapshot', async (t) => {
  const client = new FakeClient();
  const { app } = await runApp(t, client);
  emitSnapshot(client, [message(20, 'snapshot')], true);
  client.historyPages.push({
    cursor: 21,
    hasMore: false,
    records: [message(15, 'older')],
  });
  app.editor.setText('/history');
  app.editor.handleInput('\r');
  await wait(30);
  assert.equal(app.historyLoadedPages, 1);
  assert.equal(app.historyHasMore, false);

  const opensBefore = client.requests.filter(([method]) => method === 'session.open').length;
  app.editor.setText('/reconnect');
  app.editor.handleInput('\r');
  await wait(40);
  assert.equal(client.reconnects, 1);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (client.requests.filter(([method]) => method === 'session.open').length > opensBefore) break;
    await wait(5);
  }
  assert.ok(client.requests.filter(([method]) => method === 'session.open').length > opensBefore);

  emitSnapshot(client, [message(50, 'after reconnect')], true);
  assert.equal(app.historyHasMore, true);
  assert.equal(app.historyOldestSeq, 50);
  assert.equal(app.historyFirstRenderedSeq, 50);
  assert.equal(app.historyNextBeforeSeq, 50);
  assert.equal(app.historyLoadedPages, 0);
  assert.deepEqual(userTexts(app), ['after reconnect']);
});

test('refetches rows dropped by transcript trimming instead of leaving a gap', async (t) => {
  const client = new FakeClient();
  const { app } = await runApp(t, client);
  const records = Array.from({ length: 5_251 }, (_, index) => message(index, `m${index}`));
  emitSnapshot(client, records, false);

  // User messages carry a blank separator, so the row window (not the user
  // count) reaches the trim bound. Capture the exact rendered boundary.
  assert.ok(app.rows.length >= 5_000 && app.rows.length <= 5_250);
  const boundary = app.historyFirstRenderedSeq;
  assert.ok(boundary > 0);
  assert.equal(app.historyNextBeforeSeq, boundary);
  assert.equal(app.historyHasMore, true, 'trimmed rows become loadable history');

  client.historyPages.push({
    cursor: 5_251,
    hasMore: false,
    records: Array.from({ length: boundary }, (_, index) => message(index, `m${index}`)),
  });
  app.editor.setText('/history');
  app.editor.handleInput('\r');
  await wait(120);

  const request = client.requests.find(([method]) => method === 'history.events');
  assert.deepEqual(request[1], { beforeSeq: boundary });
  const texts = userTexts(app);
  assert.equal(texts.length, 5_251, 'the trimmed span is restored exactly once');
  assert.equal(new Set(texts).size, 5_251, 'no duplicate rows are introduced');
  assert.equal(texts[0], 'm0');
  assert.equal(texts[boundary - 1], `m${boundary - 1}`);
  assert.equal(texts[boundary], `m${boundary}`);
  assert.equal(texts.at(-1), 'm5250');
  assert.equal(app.historyFirstRenderedSeq, 0);
  assert.equal(app.historyNextBeforeSeq, 0);
  assert.equal(app.historyHasMore, false);
});

test('advances the cursor when a page only contains non-rendered events', async (t) => {
  const client = new FakeClient();
  const { app } = await runApp(t, client);
  emitSnapshot(client, [message(10, 'snapshot')], true);
  client.historyPages.push({
    cursor: 11,
    hasMore: true,
    records: [{ type: 'event', event: { type: 'request/context', seq: 5, time: 0, data: { model: 'm' } } }],
  });
  client.historyPages.push({
    cursor: 11,
    hasMore: false,
    records: [message(4, 'older page')],
  });

  app.editor.setText('/history');
  app.editor.handleInput('\r');
  await wait(30);
  assert.equal(app.historyFirstRenderedSeq, 10, 'no row was produced for the metadata event');
  assert.equal(app.historyNextBeforeSeq, 5, 'the cursor advances to the oldest returned record');
  assert.equal(app.historyHasMore, true);

  app.editor.setText('/history');
  app.editor.handleInput('\r');
  await wait(30);
  const requests = client.requests.filter(([method]) => method === 'history.events');
  assert.deepEqual(requests.map((entry) => entry[1].beforeSeq), [10, 5]);
  assert.deepEqual(userTexts(app), ['older page', 'snapshot']);
  assert.equal(app.historyHasMore, false);
});

test('replays history without clobbering a live turn or streaming row', async (t) => {
  const client = new FakeClient();
  const { app } = await runApp(t, client);
  emitSnapshot(client, [message(20, 'snapshot')], true);
  client.emit('frame', {
    sessionId: 's1',
    frame: { type: 'event', event: { type: 'turn/start', seq: 21, time: 0, data: { turn: 3 } } },
  });
  client.emit('frame', {
    sessionId: 's1',
    frame: { type: 'assistant-stream', frame: { type: 'start', attemptId: 'live-1', turn: 3, step: 1 } },
  });
  const live = app.live;
  assert.ok(live, 'a live assistant row exists');
  assert.equal(app.state.running, true);
  assert.equal(app.state.turn, 3);

  client.historyPages.push({
    cursor: 21,
    hasMore: false,
    records: [
      { type: 'event', event: { type: 'turn/start', seq: 8, time: 0, data: { turn: 1 } } },
      { type: 'event', event: { type: 'assistant/message', seq: 9, time: 0, data: { message: { content: [{ type: 'text', text: 'old answer' }] } } } },
      { type: 'event', event: { type: 'turn/end', seq: 10, time: 0, data: { reason: { kind: 'end' } } } },
    ],
  });
  app.editor.setText('/history');
  app.editor.handleInput('\r');
  await wait(40);

  assert.equal(app.live, live, 'the live streaming row is untouched');
  assert.equal(app.state.running, true, 'a historical turn end does not stop the live turn');
  assert.equal(app.state.turn, 3, 'historical turn metadata is discarded');
  assert.ok(app.rows.some((row) => row.text === 'old answer'), 'historical assistant output is rendered');
  assert.ok(app.rows.indexOf(app.rows.find((row) => row.text === 'old answer')) < app.rows.indexOf(live.row));
});

test('does not request history from a Host without the capability', async (t) => {
  const client = new FakeClient({ capabilities: [] });
  const { app } = await runApp(t, client);
  emitSnapshot(client, [message(10, 'snapshot')], true);
  app.editor.setText('/history');
  app.editor.handleInput('\r');
  await wait(20);
  assert.equal(client.requests.some(([method]) => method === 'history.events'), false);
  assert.ok(app.rows.some((row) => row.text?.includes('host cannot load earlier history') || row.text?.includes('Host cannot load earlier history')));
});
