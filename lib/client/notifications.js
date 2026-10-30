/**
 * Terminal-side attention signals.
 *
 * A bell is intentionally minimal: it works in most terminals, does not escape
 * the terminal's notification settings, and never blocks the UI. Set
 * `DSH_ATTACH_BELL=0` to silence it.
 */

/** @param {NodeJS.ProcessEnv} [env] */
export function bellEnabled(env = process.env) {
  return env.DSH_ATTACH_BELL !== '0';
}

/**
 * @param {{enabled?: boolean, focused?: boolean}} [state]
 * @returns {boolean}
 */
export function shouldRingBell({ enabled = true, focused = false } = {}) {
  return enabled && focused !== true;
}

export const BELL = '\x07';
