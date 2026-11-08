/**
 * Pure helpers for older-history pagination.
 *
 * DSH exposes `sessionController.events({ address, beforeSeq, maxMessages })`,
 * which returns a chronological page strictly older than `beforeSeq` plus the
 * log `cursor` and `hasMore`. The terminal client owns the rendered window, so
 * these helpers keep its boundary, ordering and status text testable without a
 * TUI or a Host.
 */

/**
 * Read one event sequence from a Session wire record.
 * @param {unknown} record
 * @returns {number|null} the safe non-negative seq, or null
 */
export function eventSeqOf(record) {
  const seq = record?.type === 'event' ? record.event?.seq : undefined;
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}

/**
 * Smallest event sequence in a record list.
 * @param {unknown[]} records
 * @returns {number|null}
 */
export function oldestEventSeq(records) {
  let oldest = null;
  for (const record of Array.isArray(records) ? records : []) {
    const seq = eventSeqOf(record);
    if (seq === null) continue;
    if (oldest === null || seq < oldest) oldest = seq;
  }
  return oldest;
}

/**
 * Validate, de-duplicate and chronologically order one older page.
 *
 * `beforeSeq` is the exclusive upper bound the client sent. A conforming Host
 * never returns a record at or above it, but dropping such records keeps a
 * malformed or overlapping page from duplicating the live window.
 *
 * @param {unknown[]} records
 * @param {number|null} beforeSeq
 * @returns {{records: object[], duplicates: number, ignored: number, oldestSeq: number|null, newestSeq: number|null}}
 */
export function orderOlderRecords(records, beforeSeq) {
  const ordered = [];
  const seen = new Set();
  let duplicates = 0;
  let ignored = 0;
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.type !== 'event' || record.event === null || typeof record.event !== 'object') {
      ignored += 1;
      continue;
    }
    const seq = eventSeqOf(record);
    if (seq === null) {
      ignored += 1;
      continue;
    }
    if (seen.has(seq) || (Number.isSafeInteger(beforeSeq) && seq >= beforeSeq)) {
      duplicates += 1;
      continue;
    }
    seen.add(seq);
    ordered.push({ seq, record });
  }
  ordered.sort((left, right) => left.seq - right.seq);
  return {
    records: ordered.map((entry) => entry.record),
    duplicates,
    ignored,
    oldestSeq: ordered.length === 0 ? null : ordered[0].seq,
    newestSeq: ordered.length === 0 ? null : ordered[ordered.length - 1].seq,
  };
}

/**
 * Scroll offset that keeps the previously visible content fixed after older
 * rows are prepended above it.
 * @param {number} scrollTop - offset before the prepend
 * @param {number} addedHeight - rendered height of the prepended rows
 * @returns {number}
 */
export function scrollTargetAfterPrepend(scrollTop, addedHeight) {
  const base = Number.isFinite(scrollTop) ? Math.max(0, Math.trunc(scrollTop)) : 0;
  const extra = Number.isFinite(addedHeight) ? Math.max(0, Math.trunc(addedHeight)) : 0;
  return base + extra;
}

/**
 * One-line activity hint for history loading state.
 * @param {{hasMore?: boolean, loading?: boolean, trimmedRows?: number}} state
 * @returns {string[]}
 */
export function historyActivityHints({ hasMore = false, loading = false, trimmedRows = 0 } = {}) {
  const hints = [];
  if (loading) hints.push('loading earlier history…');
  else if (hasMore) hints.push('earlier history not loaded · ctrl+r loads older');
  if (trimmedRows > 0) hints.push(`${trimmedRows} rows trimmed`);
  return hints;
}

/**
 * `/status` history line.
 * @param {{hasMore?: boolean, loading?: boolean, loadedPages?: number, trimmedRows?: number, hostSupports?: boolean}} state
 * @returns {string}
 */
export function historyStatusLine({
  hasMore = false,
  loading = false,
  loadedPages = 0,
  trimmedRows = 0,
  hostSupports = true,
} = {}) {
  let state;
  if (!hostSupports) state = 'earlier pages unavailable from this Host';
  else if (loading) state = 'loading earlier messages…';
  else if (hasMore) state = 'earlier messages not loaded · ctrl+r or /history loads older';
  else state = 'complete (all earlier history loaded)';
  const pages = loadedPages > 0 ? ` · ${loadedPages} older page${loadedPages === 1 ? '' : 's'} loaded` : '';
  const trimmed = trimmedRows > 0 ? ` · ${trimmedRows} rows trimmed` : '';
  return `history   ${state}${pages}${trimmed}`;
}
