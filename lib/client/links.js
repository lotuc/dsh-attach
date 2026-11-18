/**
 * Extract unique http(s) links from transcript rows, newest row first.
 * A duplicate keeps the newest occurrence, and links within one row keep their
 * left-to-right order.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gu;

function cleanUrl(raw) {
  let url = String(raw ?? '').trim();
  while (url !== '' && /[.,;:!?]$/u.test(url)) url = url.slice(0, -1);
  // A trailing ')' belongs to the URL only when the URL opened it.
  while (url.endsWith(')') && (url.match(/\(/gu)?.length ?? 0) < (url.match(/\)/gu)?.length ?? 0)) {
    url = url.slice(0, -1);
  }
  return url;
}

/**
 * @param {Array<{text?: unknown}>} rows
 * @returns {Array<{url: string, source: string}>}
 */
export function extractLinks(rows) {
  const seen = new Set();
  const links = [];
  const sourceRows = Array.isArray(rows) ? rows : [];
  for (let index = sourceRows.length - 1; index >= 0; index -= 1) {
    const row = sourceRows[index];
    const text = typeof row?.text === 'string' ? row.text : '';
    if (text === '') continue;
    for (const match of text.matchAll(URL_PATTERN)) {
      const url = cleanUrl(match[0]);
      if (url === '' || seen.has(url)) continue;
      seen.add(url);
      links.push({ url, source: text.replace(/\s+/gu, ' ').trim().slice(0, 120) });
    }
  }
  return links;
}
