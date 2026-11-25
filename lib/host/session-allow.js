/**
 * Host-side evaluation of session-scoped allow rules.
 *
 * The TUI derives one narrow rule when the human presses `s` and asks the Host
 * to mirror it. Evaluating it here means a matching approval never broadcasts
 * to a terminal or the native Web panel, so every attached client and
 * `dsh-attach --exec` sees the same decision.
 *
 * Everything is fail-closed: a missing `callId`, missing Session log, missing
 * `tool/call` event, or unparseable arguments yields no context, which means no
 * automatic allow.
 */
import { normalizeSessionRule, sessionRuleMatches } from '../shared/session-allow.js';

/** Parse tool arguments without trusting their shape. */
export function parseToolArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Read the raw arguments of one recorded tool call from the Session log.
 *
 * @param {{snapshotEvents?: () => unknown}} session
 * @param {unknown} callId
 * @returns {string|null}
 */
export function toolArgumentsForCall(session, callId) {
  if (typeof callId !== 'string' || callId === '') return null;
  if (typeof session?.snapshotEvents !== 'function') return null;
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return null;
  }
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'tool/call') continue;
    if (String(event.data?.callId ?? '') !== callId) continue;
    return typeof event.data?.arguments === 'string' ? event.data.arguments : null;
  }
  return null;
}

/**
 * Build the rule-matching context for one approval, or null when arguments
 * cannot be resolved safely.
 *
 * @param {{toolName?: unknown, callId?: unknown, session?: object|null, cwd?: unknown}} request
 * @returns {{toolName: string, cwd: unknown, arguments: object, requestedSandbox: string|null}|null}
 */
export function sessionAllowContext(request) {
  const toolName = typeof request?.toolName === 'string' && request.toolName !== '' ? request.toolName : '';
  if (toolName === '') return null;
  const raw = toolArgumentsForCall(request.session, request.callId);
  const args = parseToolArguments(raw);
  if (args === null) return null;
  return {
    toolName,
    cwd: request.cwd ?? null,
    arguments: args,
    requestedSandbox: typeof args.sandbox_permissions === 'string' ? args.sandbox_permissions : null,
  };
}

/**
 * Find the first matching session rule, if any.
 *
 * @param {object[]} rules
 * @param {object|null} context
 * @returns {object|null}
 */
export function matchSessionAllowRule(rules, context) {
  if (!Array.isArray(rules) || rules.length === 0 || context === null) return null;
  for (const rule of rules) {
    const normalized = normalizeSessionRule(rule);
    if (normalized === null) continue;
    if (sessionRuleMatches(normalized, context)) return normalized;
  }
  return null;
}
