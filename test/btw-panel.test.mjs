import assert from 'node:assert/strict';
import test from 'node:test';

import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { BtwPanel } from '../lib/client/panels.js';

test('btw panel forks a completed answer with tools', () => {
  const entries = [{ question: 'where?', status: 'done', answer: 'there', reasoning: '' }];
  let forked = null;
  const panel = new BtwPanel(entries, 0, { onFork: (entry) => { forked = entry; } });
  const text = stripTerminalSequences(panel.render(80).join('\n'));
  assert.match(text, /f fork with tools/);
  panel.handleInput('f');
  assert.equal(forked, entries[0]);
});

test('btw panel keeps earlier asides navigable and closes on escape', () => {
  const entries = [
    { question: 'first', status: 'done', answer: 'one', reasoning: '' },
    { question: 'second', status: 'done', answer: 'two', reasoning: '' },
  ];
  let closed = false;
  const panel = new BtwPanel(entries, 1, { onClose: () => { closed = true; } });
  assert.match(stripTerminalSequences(panel.render(80).join('\n')), /2\/2/);
  panel.handleInput('[');
  assert.match(stripTerminalSequences(panel.render(80).join('\n')), /1\/2/);
  panel.handleInput('\x1b');
  assert.equal(closed, true);
});
