import assert from 'node:assert/strict';
import test from 'node:test';

import {
  eventSeqOf,
  historyActivityHints,
  historyStatusLine,
  oldestEventSeq,
  orderOlderRecords,
  scrollTargetAfterPrepend,
} from '../lib/client/history-pagination.js';

function record(seq, text = `event ${seq}`) {
  return {
    type: 'event',
    event: { type: 'user/message', seq, time: 0, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } },
  };
}

test('reads only validated event sequences', () => {
  assert.equal(eventSeqOf(record(7)), 7);
  assert.equal(eventSeqOf(record(0)), 0);
  assert.equal(eventSeqOf({ type: 'event', event: { seq: -1 } }), null);
  assert.equal(eventSeqOf({ type: 'event', event: { seq: 1.5 } }), null);
  assert.equal(eventSeqOf({ type: 'event', event: {} }), null);
  assert.equal(eventSeqOf({ type: 'notification', event: { seq: 3 } }), null);
  assert.equal(eventSeqOf(null), null);
});

test('finds the oldest event sequence in a page', () => {
  assert.equal(oldestEventSeq([record(9), record(4), record(12)]), 4);
  assert.equal(oldestEventSeq([{ type: 'event', event: {} }]), null);
  assert.equal(oldestEventSeq([]), null);
});

test('orders older records chronologically and drops overlapping records', () => {
  const page = orderOlderRecords([record(9), record(5), record(5), record(10), { type: 'noise' }, record(7)], 10);
  assert.deepEqual(page.records.map((entry) => entry.event.seq), [5, 7, 9]);
  assert.equal(page.duplicates, 2, 'the repeated seq and the seq at the exclusive boundary are dropped');
  assert.equal(page.ignored, 1);
  assert.equal(page.oldestSeq, 5);
  assert.equal(page.newestSeq, 9);
});

test('an empty older page reports no cursor', () => {
  assert.deepEqual(orderOlderRecords([], 0), {
    records: [],
    duplicates: 0,
    ignored: 0,
    oldestSeq: null,
    newestSeq: null,
  });
  assert.deepEqual(orderOlderRecords(undefined, null), {
    records: [],
    duplicates: 0,
    ignored: 0,
    oldestSeq: null,
    newestSeq: null,
  });
});

test('keeps a previous cursor when the next older page is empty', () => {
  const page = orderOlderRecords([], 10);
  assert.equal(page.oldestSeq, null, 'the caller keeps its own boundary instead of inventing one');
});

test('scroll target moves down by the prepended rendered height', () => {
  assert.equal(scrollTargetAfterPrepend(120, 15), 135);
  assert.equal(scrollTargetAfterPrepend(0, 7), 7);
  assert.equal(scrollTargetAfterPrepend(-4, 7), 7);
  assert.equal(scrollTargetAfterPrepend(12, -3), 12);
  assert.equal(scrollTargetAfterPrepend(undefined, 5), 5);
});

test('activity hints distinguish loading, more history, and trimming', () => {
  assert.deepEqual(historyActivityHints({}), []);
  assert.deepEqual(historyActivityHints({ hasMore: true }), ['earlier history not loaded · ctrl+r loads older']);
  assert.deepEqual(historyActivityHints({ loading: true, hasMore: true }), ['loading earlier history…']);
  assert.deepEqual(historyActivityHints({ hasMore: true, trimmedRows: 3 }), [
    'earlier history not loaded · ctrl+r loads older',
    '3 rows trimmed',
  ]);
});

test('status line reports completeness, pages, trimming, and old Hosts', () => {
  assert.match(historyStatusLine({ hasMore: true }), /earlier messages not loaded · ctrl\+r or \/history/);
  assert.match(historyStatusLine({ loading: true, hasMore: true }), /loading earlier messages/);
  assert.match(historyStatusLine({ hasMore: false }), /complete \(all earlier history loaded\)/);
  assert.match(historyStatusLine({ hasMore: false, loadedPages: 2 }), /2 older pages loaded/);
  assert.match(historyStatusLine({ hasMore: false, loadedPages: 1, trimmedRows: 4 }), /1 older page loaded · 4 rows trimmed/);
  assert.match(historyStatusLine({ hostSupports: false, hasMore: true }), /unavailable from this Host/);
});
