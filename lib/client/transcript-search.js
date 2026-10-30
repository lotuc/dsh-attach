/**
 * Search over the currently loaded transcript.
 *
 * Rows render themselves, so the search sees exactly what the user sees.
 * Groups that are collapsed hide their children here too; expanding them makes
 * the children searchable.
 */
import { stripTerminalSequences } from '@earendil-works/pi-tui';

import { oneLine } from './transcript.js';

/**
 * @param {Array<{render(width: number): string[]}>} rows
 * @param {number} width
 * @returns {Array<{value: string, label: string, description: string, meta: string, offset: number, rowIndex: number}>}
 */
export function buildTranscriptSearch(rows, width) {
  const items = [];
  let offset = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    let lines = [];
    try {
      lines = row.render(width) ?? [];
    } catch {
      lines = [];
    }
    const text = lines.map((line) => stripTerminalSequences(String(line))).join('\n').trim();
    if (text !== '') {
      items.push({
        value: String(index),
        label: oneLine(text, 120),
        description: `row ${index + 1} · line ${offset + 1}`,
        meta: text,
        offset,
        rowIndex: index,
      });
    }
    offset += lines.length;
  }
  return items;
}

/**
 * Find the first item containing `query`, case-insensitively.
 * @param {Array<{meta: string}>} items
 * @param {string} query
 * @returns {object|null}
 */
export function firstTranscriptMatch(items, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') return null;
  return items.find((item) => item.meta.toLowerCase().includes(needle)) ?? null;
}
