import assert from 'node:assert/strict';
import test from 'node:test';

import { extractLinks } from '../lib/client/links.js';

test('extracts unique links and trims prose punctuation', () => {
  const rows = [
    { text: 'see https://example.com/docs.' },
    { text: '[API](https://example.com/api), https://example.com/docs' },
    { text: 'no link' },
  ];
  assert.deepEqual(extractLinks(rows).map((link) => link.url), ['https://example.com/docs', 'https://example.com/api']);
});
