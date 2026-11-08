/**
 * One user-facing transcript detail control.
 *
 * Rather than three independent toggles for turns, step groups, tools, and
 * reasoning, the TUI exposes three named levels. `Ctrl+G` and `/detail` both
 * move through the same list.
 */
export const DETAIL_LEVELS = Object.freeze(['compact', 'standard', 'verbose']);
export const DEFAULT_DETAIL_LEVEL = 'standard';

const DETAIL_FLAGS = Object.freeze({
  compact: Object.freeze({
    reasoning: false,
    tools: false,
    steps: false,
    liveWork: false,
    completedWork: false,
  }),
  standard: Object.freeze({
    reasoning: false,
    tools: false,
    steps: false,
    liveWork: true,
    completedWork: false,
  }),
  verbose: Object.freeze({
    reasoning: true,
    tools: true,
    steps: true,
    liveWork: true,
    completedWork: true,
  }),
});

/** Normalize a user/config value to a known detail level. */
export function normalizeDetailLevel(value, fallback = DEFAULT_DETAIL_LEVEL) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return DETAIL_LEVELS.includes(normalized) ? normalized : fallback;
}

/** The next level in the compact -> standard -> verbose cycle. */
export function nextDetailLevel(level) {
  const current = normalizeDetailLevel(level);
  const index = DETAIL_LEVELS.indexOf(current);
  return DETAIL_LEVELS[(index + 1) % DETAIL_LEVELS.length];
}

/** Feature flags for one detail level. */
export function detailFlags(level) {
  return DETAIL_FLAGS[normalizeDetailLevel(level)];
}
