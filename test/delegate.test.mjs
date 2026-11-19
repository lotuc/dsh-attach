import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDelegatePrompt } from '../lib/client/delegate.js';

test('builds a self-contained delegation prompt', () => {
  const prompt = buildDelegatePrompt({
    request: '把 popup 全屏边框去掉',
    cwd: '/tmp/work',
    sessionId: 's1',
    title: 'TUI fixes',
  });
  assert.match(prompt, /^DELEGATION REQUEST/u);
  assert.match(prompt, /> 把 popup 全屏边框去掉/u);
  assert.match(prompt, /- session: s1/u);
  assert.match(prompt, /- cwd: \/tmp\/work/u);
  assert.match(prompt, /Actually start|actually start/u);
  assert.match(prompt, /Do not stop at printing the brief/u);
  assert.match(prompt, /Acceptance criteria/u);
  assert.match(prompt, /forked subagent only when/u);
  assert.match(prompt, /After spawning/u);
});

test('quotes multi-line requests and rejects an empty one', () => {
  const prompt = buildDelegatePrompt({ request: 'first\nsecond' });
  assert.match(prompt, /> first\n> second/u);
  assert.throws(() => buildDelegatePrompt({ request: '   ' }), /request is required/u);
});
