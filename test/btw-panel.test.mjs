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

test('btw panel copies, clears and dismisses completed answers', () => {
  const entries = [{ question: 'where?', status: 'done', answer: '# There', reasoning: '', provider: 'p', model: 'm' }];
  let copied = null;
  let cleared = 0;
  let closed = 0;
  const panel = new BtwPanel(entries, 0, {
    onCopy: (entry) => { copied = entry; },
    onClear: () => { cleared += 1; },
    onClose: () => { closed += 1; },
  });
  const text = stripTerminalSequences(panel.render(80).join('\n'));
  assert.match(text, /p\/m/);
  assert.match(text, /c copy/);
  assert.match(text, /x clear/);
  panel.handleInput('c');
  assert.equal(copied, entries[0]);
  panel.handleInput('x');
  assert.equal(cleared, 1);
  panel.handleInput(' ');
  assert.equal(closed, 1);
});

test('btw panel cancels an answering question on escape', () => {
  const entries = [{ question: 'slow?', status: 'answering', answer: 'partial', reasoning: '' }];
  let cancelled = null;
  let closed = 0;
  const panel = new BtwPanel(entries, 0, {
    onCancel: (entry) => { cancelled = entry; },
    onClose: () => { closed += 1; },
  });
  const text = stripTerminalSequences(panel.render(80).join('\n'));
  assert.match(text, /esc cancel/);
  assert.match(text, /partial/);
  panel.handleInput('\x1b');
  assert.equal(cancelled, entries[0]);
  assert.equal(closed, 0);
});

test('btw panel toggles fullscreen with F and keeps the answer intact', () => {
  const entries = [{ question: 'where?', status: 'done', answer: 'there', reasoning: '' }];
  const states = [];
  const panel = new BtwPanel(entries, 0, { onToggleFullscreen: (value) => states.push(value) });
  assert.match(stripTerminalSequences(panel.render(80).join('\n')), /F fullscreen/);
  panel.handleInput('F');
  assert.deepEqual(states, [true]);
  assert.match(stripTerminalSequences(panel.render(80).join('\n')), /F windowed/);
  panel.handleInput('F');
  assert.deepEqual(states, [true, false]);
});
