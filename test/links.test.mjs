import assert from 'node:assert/strict';
import test from 'node:test';

import { extractLinks } from '../lib/client/links.js';

test('extracts unique links and trims prose punctuation', () => {
  const rows = [
    { text: 'see https://example.com/docs.' },
    { text: '[API](https://example.com/api), https://example.com/docs' },
    { text: 'no link' },
  ];
  assert.deepEqual(extractLinks(rows).map((link) => link.url), ['https://example.com/api', 'https://example.com/docs']);
});

test('lists the newest transcript rows first and keeps the newest duplicate', () => {
  const rows = [
    { text: 'top https://example.com/old' },
    { text: 'middle https://example.com/middle' },
    { text: 'bottom https://example.com/new and https://example.com/old' },
  ];
  const links = extractLinks(rows);
  assert.deepEqual(links.map((link) => link.url), [
    'https://example.com/new',
    'https://example.com/old',
    'https://example.com/middle',
  ]);
  assert.match(links[1].source, /^bottom /u);
});
