import assert from 'node:assert/strict';
import test from 'node:test';

import { oneLine, sanitizeText } from '../lib/client/transcript.js';

test('strips terminal control sequences from untrusted text', () => {
  const input = 'hi\x1b]52;c;ZXZpbA==\x07 \x1b[31mred\x1b[0m \x1b]0;title\x07 done\u0000';
  assert.equal(sanitizeText(input), 'hi red  done');
});

test('keeps newlines for markdown but flattens one-line previews', () => {
  assert.equal(sanitizeText('a\nb'), 'a\nb');
  assert.equal(oneLine('a\nb\tc'), 'a b c');
});
