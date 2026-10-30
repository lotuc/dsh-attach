/**
 * Human-facing text for approval reasons.
 *
 * `displayReason` is a localized `{ en, zh, ... }` map in the Host API, while
 * older Hosts send a plain string. Both the bridge and the TUI panel need the
 * same fallback order.
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
export function approvalReasonText(value) {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return '';
  for (const key of ['zh', 'zh-Hans', 'zh-CN', 'en']) {
    if (typeof value[key] === 'string' && value[key].trim() !== '') return value[key];
  }
  for (const candidate of Object.values(value)) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return '';
}
