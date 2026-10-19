import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyInboxSplice,
  emptyInbox,
  normalizeInbox,
  removeInboxMessage,
  removeInboxMessageByText,
  visibleInboxEntries,
} from '../lib/client/inbox.js';

const textOf = (message) => message.content?.map((block) => block.text ?? '').join('') ?? '';

test('normalizes projection keys and keeps injected context in the durable lists', () => {
  const inbox = normalizeInbox({
    'next-turn': [{ id: 'a', source: { kind: 'user' }, content: [{ type: 'text', text: 'later' }] }],
    'next-step': [{ id: 'b', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'ctx' }] }],
  });
  assert.equal(inbox.nextTurn.length, 1);
  assert.equal(inbox.nextStep.length, 1);
  assert.deepEqual(visibleInboxEntries(inbox).map((entry) => entry.message.id), ['a']);
});

test('applies insert, claim and cancel splices against the complete list', () => {
  let inbox = emptyInbox();
  let result = applyInboxSplice(inbox, {
    target: 'next-turn',
    start: 0,
    inserted: [
      { id: 'a', source: { kind: 'user' }, content: [{ type: 'text', text: 'queued' }] },
    ],
  });
  inbox = result.inbox;
  result = applyInboxSplice(inbox, {
    target: 'next-step',
    start: 0,
    inserted: [
      { id: 'ctx', source: { kind: 'runtime-context' }, content: [] },
    ],
  });
  inbox = result.inbox;
  assert.deepEqual(inbox.nextTurn.map((message) => message.id), ['a']);
  assert.deepEqual(inbox.nextStep.map((message) => message.id), ['ctx']);
  assert.deepEqual(visibleInboxEntries(inbox).map((entry) => entry.message.id), ['a']);

  result = applyInboxSplice(inbox, {
    target: 'next-turn',
    start: 0,
    removedCount: 1,
    inserted: [],
  });
  assert.deepEqual(result.removed.map((message) => message.id), ['a']);
  assert.deepEqual(result.inbox.nextTurn, []);
  inbox = result.inbox;

  result = applyInboxSplice(inbox, {
    target: 'next-step',
    start: 0,
    removedCount: 1,
    inserted: [],
    outcome: 'canceled',
  });
  assert.deepEqual(result.removed.map((message) => message.id), ['ctx']);
  assert.deepEqual(result.inbox.nextStep, []);
});

test('replaces a queued message while keeping the durable list coherent', () => {
  const inbox = normalizeInbox({
    'next-turn': [{ id: 'old', source: { kind: 'user' }, content: [{ type: 'text', text: 'old' }] }],
    'next-step': [],
  });
  const result = applyInboxSplice(inbox, {
    target: 'next-turn',
    start: 0,
    removedCount: 1,
    inserted: [{ id: 'new', source: { kind: 'user' }, content: [{ type: 'text', text: 'new' }] }],
    outcome: 'canceled',
  });
  assert.deepEqual(result.removed.map((message) => message.id), ['old']);
  assert.deepEqual(result.inbox.nextTurn.map((message) => message.id), ['new']);
});

test('removes claimed messages by id and falls back to text for legacy hosts', () => {
  const inbox = normalizeInbox({
    'next-turn': [
      { id: 'a', source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] },
      { id: 'b', source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }] },
    ],
    'next-step': [],
  });
  assert.equal(removeInboxMessage(inbox, { id: 'missing' }), inbox);
  assert.deepEqual(removeInboxMessage(inbox, { id: 'b' }).nextTurn.map((message) => message.id), ['a']);
  assert.deepEqual(removeInboxMessageByText(inbox, 'first', textOf).nextTurn.map((message) => message.id), ['b']);
});

test('ignores malformed splices and empty targets', () => {
  const inbox = normalizeInbox({ 'next-turn': [{ id: 'a' }], 'next-step': [] });
  assert.equal(applyInboxSplice(inbox, { target: 'unknown', start: 0 }).inbox, inbox);
  assert.equal(applyInboxSplice(inbox, { target: 'next-turn', start: -1 }).inbox, inbox);
  assert.equal(applyInboxSplice(inbox, { target: 'next-turn', start: 0, removedCount: -1 }).inbox, inbox);
});
