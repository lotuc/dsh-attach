import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJsonc } from '../lib/shared/jsonc.js';

test('parses comments and trailing commas outside strings', () => {
  const value = parseJsonc(`{
    // line comment
    "enabled": true,
    "url": "https://example.test/a//b",
    "list": [1, 2, /* block */ 3,],
  }`);
  assert.deepEqual(value, { enabled: true, url: 'https://example.test/a//b', list: [1, 2, 3] });
});

test('rejects malformed JSONC through JSON.parse', () => {
  assert.throws(() => parseJsonc('{ "enabled": true, '), /JSON/u);
});
