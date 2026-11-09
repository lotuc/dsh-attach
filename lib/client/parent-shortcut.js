/** Quick parent navigation while viewing a read-only subagent history. */
import { isEscape } from './keys.js';
import { matchesKey } from '@earendil-works/pi-tui';

/**
 * @param {{data: string, subagent: boolean, running: boolean, editorText: string, overlayOpen: boolean, autocompleteOpen: boolean}} input
 * @returns {boolean}
 */
export function shouldOpenParent(input) {
  if (!input?.subagent || input.overlayOpen || input.autocompleteOpen) return false;
  const empty = String(input.editorText ?? '') === '';
  if (matchesKey(input.data, 'alt+left')) return true;
  if (empty && matchesKey(input.data, 'backspace')) return true;
  // Escape is intentionally limited to an idle subagent: while it is running,
  // Esc-Esc remains the interrupt gesture.
  return empty && !input.running && isEscape(input.data);
}
