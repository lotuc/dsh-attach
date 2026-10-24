import assert from 'node:assert/strict';
import test from 'node:test';

import { stripTerminalSequences } from '@earendil-works/pi-tui';

import { ReasoningRow } from '../lib/client/transcript.js';

function text(row, width = 80) {
  return stripTerminalSequences(row.render(width).join('\n'));
}

test('collapsed reasoning previews the live tail, not the first line', () => {
  const row = new ReasoningRow('first stable line\nlatest streamed line', () => false);
  assert.match(text(row), /latest streamed line/);
  assert.doesNotMatch(text(row), /first stable line/);
  assert.match(text(row), /chars/);
  row.setText('first stable line\nlatest streamed line\nnewest line');
  assert.match(text(row), /newest line/);
});
