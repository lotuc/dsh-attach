/**
 * Runtime regex validation for auto-approval rules.
 *
 * `redos-detector` catches super-linear backtracking that a plain
 * `new RegExp()` compile cannot see. Every unique pattern is checked once and
 * cached; an invalid, unsafe, or timed-out pattern is never executed against
 * an approval's command or path.
 */
import { isSafePattern } from 'redos-detector';

const CACHE_LIMIT = 256;
const cache = new Map();

/**
 * Compile and analyze one pattern with the same `u` flag used by rule matching.
 * @param {unknown} pattern
 * @returns {{valid: boolean, safe: boolean, reason: string, regex: RegExp|null}}
 */
export function checkRegex(pattern) {
  if (typeof pattern !== 'string' || pattern === '') {
    return { valid: false, safe: false, reason: 'pattern is empty', regex: null };
  }
  const cached = cache.get(pattern);
  if (cached !== undefined) return cached;
  let regex;
  try {
    regex = new RegExp(pattern, 'u');
  } catch (error) {
    const result = {
      valid: false,
      safe: false,
      reason: `invalid regex: ${error instanceof Error ? error.message : String(error)}`,
      regex: null,
    };
    remember(pattern, result);
    return result;
  }
  let analysis;
  try {
    // Analyze the pattern as a full-string match. The rule matcher may search
    // an unanchored substring, but that prefix scan is linear; wrapping avoids
    // the detector's downgraded `[^]*?` prefix, which false-positives simple
    // deny patterns such as `rm\s+-rf`.
    analysis = isSafePattern(`^(?:${pattern})$`, {
      unicode: true,
      maxScore: 100,
      maxSteps: 20_000,
      timeout: 100,
      downgradePattern: false,
    });
  } catch (error) {
    const result = {
      valid: true,
      safe: false,
      reason: `regex safety check failed: ${error instanceof Error ? error.message : String(error)}`,
      regex: null,
    };
    remember(pattern, result);
    return result;
  }
  const safe = analysis?.safe === true;
  const result = {
    valid: true,
    safe,
    reason: safe ? '' : `potential ReDoS (${analysis?.error ?? 'unsafe'})`,
    regex: safe ? regex : null,
  };
  remember(pattern, result);
  return result;
}

/**
 * Test one value only when the pattern passed both compile and ReDoS checks.
 * @param {unknown} pattern
 * @param {unknown} value
 * @returns {boolean}
 */
export function safeRegexTest(pattern, value) {
  const result = checkRegex(pattern);
  if (!result.valid || !result.safe || result.regex === null) return false;
  try {
    return result.regex.test(String(value));
  } catch {
    return false;
  }
}

function remember(pattern, result) {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(pattern, result);
}
