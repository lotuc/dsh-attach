/**
 * Narrow Herdr environment bridge for model shell calls.
 *
 * The DSH shell tool runs in the Host process, not in the terminal pane that
 * launched dsh-attach. Only explicitly named HERDR_* facts are accepted from
 * the client and merged into the request's ordinary `env`; the managed DSH_*
 * snapshot remains authoritative and is never overridden here.
 */

const MAX_ENTRIES = 32;
const MAX_VALUE_BYTES = 8 * 1024;
const HERDR_KEY = /^HERDR_[A-Z0-9_]+$/u;

/** @param {unknown} value */
export function herdrEnvFromClient(value) {
  const result = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(result).length >= MAX_ENTRIES) break;
    if (!HERDR_KEY.test(key)) continue;
    if (typeof raw !== 'string' || raw === '' || Buffer.byteLength(raw, 'utf8') > MAX_VALUE_BYTES) continue;
    result[key] = raw;
  }
  return result;
}

/**
 * Merge accepted client environment into one shell resolve request.
 * @param {object} request
 * @param {Record<string, string>|null|undefined} env
 * @returns {object}
 */
export function mergeShellEnv(request, env) {
  if (env === null || env === undefined || Object.keys(env).length === 0) return request;
  return {
    ...request,
    env: {
      ...(request?.env !== null && typeof request?.env === 'object' ? request.env : {}),
      ...env,
    },
  };
}
