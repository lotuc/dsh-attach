/**
 * Client-side approval whitelist matching and LLM review payloads.
 *
 * Auto-approval is deliberately two-stage: a deterministic rule must match the
 * tool call first, then the Host reviewer may still return `ask`. The reviewer
 * can never widen the whitelist, and `danger-full-access` requires an explicit
 * per-rule opt-in.
 */

export const AUTO_APPROVE_TIMEOUT_MS = 10_000;

/** Parse the raw tool arguments without trusting their shape. */
export function parseToolArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Normalize one config object; unknown or malformed rules are dropped. */
export function normalizeAutoApprovalConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { enabled: false, rules: [] };
  const rules = [];
  for (const item of Array.isArray(raw.rules) ? raw.rules : []) {
    if (item === null || typeof item !== 'object' || item.enabled === false) continue;
    const tool = typeof item.tool === 'string' && item.tool.trim() !== '' ? item.tool.trim() : '*';
    const rule = {
      id: typeof item.id === 'string' && item.id.trim() !== '' ? item.id.trim() : `rule-${rules.length + 1}`,
      tool,
      description: typeof item.description === 'string' ? item.description.trim() : '',
      allowFullAccess: item.allowFullAccess === true,
    };
    if (typeof item.command === 'string' && item.command !== '') rule.command = item.command;
    if (typeof item.path === 'string' && item.path !== '') rule.path = item.path;
    if (typeof item.sandbox === 'string' && item.sandbox !== '') rule.sandbox = item.sandbox;
    rules.push(rule);
  }
  return {
    enabled: raw.enabled === true,
    ...(Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? { timeoutMs: Math.min(60_000, Math.floor(raw.timeoutMs)) } : {}),
    rules,
  };
}

function regexMatches(pattern, value) {
  if (typeof pattern !== 'string' || typeof value !== 'string') return false;
  try {
    return new RegExp(pattern, 'u').test(value);
  } catch {
    return false;
  }
}

function pathOf(args) {
  return typeof args?.path === 'string'
    ? args.path
    : typeof args?.file_path === 'string'
      ? args.file_path
      : typeof args?.file === 'string'
        ? args.file
        : '';
}

/** Whether one rule structurally matches an approval request. */
export function ruleMatches(rule, context) {
  if (rule === null || typeof rule !== 'object') return false;
  if (rule.tool !== '*' && rule.tool !== context.toolName) return false;
  const args = context.arguments ?? {};
  const requested = context.requestedSandbox ?? '';
  if (rule.sandbox !== undefined && rule.sandbox !== requested) return false;
  if (requested === 'danger-full-access' && rule.allowFullAccess !== true) return false;
  if (rule.command !== undefined && !regexMatches(rule.command, typeof args.command === 'string' ? args.command : '')) return false;
  if (rule.path !== undefined && !regexMatches(rule.path, pathOf(args))) return false;
  return true;
}

/** Find the first matching rule; the order in the file is the priority. */
export function findAutoApprovalRule(config, context) {
  if (config?.enabled !== true || !Array.isArray(config.rules)) return null;
  return config.rules.find((rule) => ruleMatches(rule, context)) ?? null;
}

/** Build the isolated reviewer payload; no conversation or hidden reasoning. */
export function buildReviewPayload(context, rule) {
  return {
    toolName: context.toolName,
    reason: typeof context.reason === 'string' ? context.reason : '',
    displayReason: typeof context.displayReason === 'string' ? context.displayReason : '',
    currentSandbox: context.currentSandbox ?? null,
    requestedSandbox: context.requestedSandbox ?? null,
    arguments: context.arguments ?? {},
    rule: {
      id: rule.id,
      description: rule.description ?? '',
      tool: rule.tool,
      ...(rule.command === undefined ? {} : { command: rule.command }),
      ...(rule.path === undefined ? {} : { path: rule.path }),
      ...(rule.sandbox === undefined ? {} : { sandbox: rule.sandbox }),
      allowFullAccess: rule.allowFullAccess === true,
    },
  };
}

/** Only an explicit allow verdict is actionable; everything else asks a human. */
export function normalizeReviewVerdict(value) {
  const verdict = value?.verdict === 'allow' ? 'allow' : 'ask';
  const reason = typeof value?.reason === 'string' ? value.reason.trim() : '';
  return { verdict, reason };
}
