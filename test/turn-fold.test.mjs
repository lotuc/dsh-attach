import assert from 'node:assert/strict';
import test from 'node:test';

import { TranscriptDocument, TurnFoldRow, formatTurnDuration } from '../lib/client/turn-fold.js';

test('formats compact turn durations', () => {
  assert.equal(formatTurnDuration(0), '<1s');
  assert.equal(formatTurnDuration(2_400), '2s');
  assert.equal(formatTurnDuration(65_000), '1m 5s');
  assert.equal(formatTurnDuration(120_000), '2m');
});

test('summarizes one turn and hides its process rows when collapsed', () => {
  const fold = new TurnFoldRow({ turn: 3, startedAt: 1_000, now: 1_000 });
  const first = { hiddenByTurn: false };
  const second = { hiddenByTurn: false };
  fold.addTool();
  fold.addTool();
  fold.processRows.add(first);
  fold.processRows.add(second);
  assert.match(fold.render(100).join('\n'), /Working · 2 tool calls/);
  assert.equal(fold.collapsed, false);

  fold.finish({ endedAt: 66_000 });
  assert.equal(fold.collapsed, true);
  assert.equal(first.hiddenByTurn, true);
  assert.equal(second.hiddenByTurn, true);
  assert.match(fold.render(100).join('\n'), /Completed at .* · 1m 5s · 2 tool calls/);

  fold.setCollapsed(false);
  assert.equal(first.hiddenByTurn, false);
  assert.match(fold.render(100).join('\n'), /^▾/);
});

test('marks failed turns and thought-only turns', () => {
  const failed = new TurnFoldRow({ turn: 1, startedAt: 0 });
  failed.addTool();
  failed.addFailure();
  failed.finish({ endedAt: 3_000, failed: true });
  assert.match(failed.render(100).join('\n'), /Failed at .* · 3s · 1 tool call/);

  const thought = new TurnFoldRow({ turn: 2, startedAt: 0 });
  thought.finish({ endedAt: 4_000 });
  assert.match(thought.render(100).join('\n'), /Thought for a while at /);
});

test('TranscriptDocument omits hidden rows while preserving visible order', () => {
  const document = new TranscriptDocument((wrapper) => wrapper.row.hidden === true);
  const row = (text, hidden = false) => ({ row: { hidden }, render: () => [text] });
  document.addChild(row('header'));
  document.addChild(row('tool', true));
  document.addChild(row('answer'));
  assert.deepEqual(document.render(80), ['header', 'answer']);
});
