import assert from 'node:assert/strict';
import test from 'node:test';

import { queueItems, queueSections, queueText } from '../lib/client/queue.js';

const entries = [
  {
    target: 'next-turn',
    label: 'next turn',
    message: { id: 'm1', content: [{ type: 'text', text: 'later prompt' }] },
  },
  {
    target: 'next-step',
    label: 'next step',
    message: { id: 'm2', content: [{ type: 'text', text: 'steer this' }] },
  },
];

test('formats queued prompts with their delivery target', () => {
  const items = queueItems(entries);
  assert.deepEqual(items.map((item) => item.value), ['m1', 'm2']);
  assert.match(items[0].label, /queued.*later prompt/);
  assert.equal(items[0].meta, 'next turn');
  assert.match(items[1].label, /steering.*steer this/);
  assert.equal(items[1].meta, 'next step');
  assert.equal(queueText(entries[1]), 'steer this');
});

test('builds read-only queue details and keeps ids searchable', () => {
  assert.deepEqual(queueSections(entries[0]), [
    { label: 'Message', text: 'later prompt' },
    { label: 'Delivery', text: 'next turn' },
    { label: 'Item', text: 'm1' },
  ]);
  const fallback = queueItems([{ target: 'next-turn', label: 'next turn', message: { content: [] } }]);
  assert.equal(fallback[0].value, 'next-turn:0');
  assert.equal(fallback[0].label, '› queued · (no text)');
});
