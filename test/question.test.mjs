import assert from 'node:assert/strict';
import test from 'node:test';

import { stripTerminalSequences } from '@earendil-works/pi-tui';

import { QuestionPanel } from '../lib/client/panels.js';

function plain(lines) {
  return stripTerminalSequences(lines.join('\n'));
}

test('shows a focused input for a free-text question', () => {
  let answer = null;
  const panel = new QuestionPanel({
    questions: [{ id: 'q1', question: 'What should I name it?' }],
  }, {
    onSubmit: (value) => { answer = value; },
    requestRender: () => {},
  });
  panel.focused = true;

  assert.equal(panel.mode, 'custom');
  assert.match(plain(panel.render(70)), /your answer/);
  panel.handleInput('R');
  panel.handleInput('e');
  panel.handleInput('p');
  assert.match(plain(panel.render(70)), /Rep/);
  panel.handleInput('\r');
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: [], custom: 'Rep' }] });
});

test('enters a free-text question after a multiple-choice question', () => {
  let answer = null;
  const panel = new QuestionPanel({
    questions: [
      { id: 'q1', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'q2', question: 'Explain' },
    ],
  }, {
    onSubmit: (value) => { answer = value; },
    requestRender: () => {},
  });
  panel.focused = true;
  panel.handleInput('\r');
  assert.equal(panel.index, 1);
  assert.equal(panel.mode, 'custom');
  assert.match(plain(panel.render(70)), /your answer/);
  panel.handleInput('x');
  panel.handleInput('\r');
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: [], custom: 'x' }] });
});
