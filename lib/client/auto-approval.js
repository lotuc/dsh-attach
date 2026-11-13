/**
 * Client-side approval whitelist matching and LLM review payloads.
 *
 * Auto-approval is deliberately two-stage: a deterministic structured rule
 * must match the tool call first, then the Host reviewer may still return
 * `ask`. The reviewer can never widen the whitelist, and `danger-full-access`
 * requires an explicit per-rule opt-in.
 */
import {
  isPathWithin,
  isSafeReadOnlyCommand,
  matchesCommandPrefix,
  normalizeCommand,
  normalizeCommandPrefix,
  splitShellCommands,
} from '../shared/command-rules.js';

export const AUTO_APPROVE_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_AUTO_APPROVALS = 20;

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

function strings(values) {
  return (Array.isArray(values) ? values : []).filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => value.trim());
}

function normalizePrefixes(values) {
  const prefixes = [];
  for (const value of Array.isArray(values) ? values : []) {
    const prefix = normalizeCommandPrefix(value);
    if (prefix !== null) prefixes.push(prefix);
  }
  return prefixes;
}

/** Normalize one config object; unknown or malformed rules are dropped. */
export function normalizeAutoApprovalConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: false, mode: 'rules', rules: [], humanOnlyPrefixes: [] };
  }
  const rules = [];
  for (const item of Array.isArray(raw.rules) ? raw.rules : []) {
    if (item === null || typeof item !== 'object' || item.enabled === false) continue;
    const tool = typeof item.tool === 'string' && item.tool.trim() !== '' ? item.tool.trim() : '*';
    const commandPrefix = item.commandPrefix === undefined ? null : normalizeCommandPrefix(item.commandPrefix);
    if (item.commandPrefix !== undefined && commandPrefix === null) continue;
    const rule = {
      id: typeof item.id === 'string' && item.id.trim() !== '' ? item.id.trim() : `rule-${rules.length + 1}`,
      tool,
      description: typeof item.description === 'string' ? item.description.trim() : '',
      allowFullAccess: item.allowFullAccess === true,
    };
    if (commandPrefix !== null) rule.commandPrefix = commandPrefix;
    if (typeof item.pathPrefix === 'string' && item.pathPrefix.trim() !== '') rule.pathPrefix = item.pathPrefix.trim();
    if (typeof item.cwdPrefix === 'string' && item.cwdPrefix.trim() !== '') rule.cwdPrefix = item.cwdPrefix.trim();
    if (typeof item.sandbox === 'string' && item.sandbox !== '') rule.sandbox = item.sandbox;
    rules.push(rule);
  }
  return {
    enabled: raw.enabled === true,
    mode: raw.mode === 'review' ? 'review' : 'rules',
    policy: typeof raw.policy === 'string' ? raw.policy.trim() : '',
    humanOnly: strings(raw.humanOnly),
    humanOnlyPrefixes: normalizePrefixes(raw.humanOnlyPrefixes),
    allowFullAccess: raw.allowFullAccess === true,
    maxAutoApprovals: Number.isFinite(raw.maxAutoApprovals) && raw.maxAutoApprovals >= 0
      ? Math.floor(raw.maxAutoApprovals)
      : DEFAULT_MAX_AUTO_APPROVALS,
    ...(Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? { timeoutMs: Math.min(60_000, Math.floor(raw.timeoutMs)) } : {}),
    rules,
  };
}

function pathOf(args) {
  return typeof args?.path === 'string'
    ? args.path
    : typeof args.file_path === 'string'
      ? args.file_path
      : typeof args.file === 'string'
        ? args.file
        : '';
}

/** The non-empty normalized commands in one shell line, or null if unparseable. */
export function commandSegments(context) {
  const command = typeof context?.arguments?.command === 'string' ? context.arguments.command : '';
  if (command === '') return [];
  const parsed = splitShellCommands(command);
  if (parsed === null) return null;
  return parsed.map(normalizeCommand);
}

/**
 * Whether one rule structurally matches one approval request.
 * `segments` is optional; when present it is the normalized command currently
 * being checked by findAutoApprovalRule.
 */
export function ruleMatches(rule, context, segments = undefined) {
  if (rule === null || typeof rule !== 'object') return false;
  if (rule.tool !== '*' && rule.tool !== context.toolName) return false;
  const args = context.arguments ?? {};
  const requested = context.requestedSandbox ?? '';
  if (rule.sandbox !== undefined && rule.sandbox !== requested) return false;
  if (requested === 'danger-full-access' && rule.allowFullAccess !== true) return false;
  if (rule.cwdPrefix !== undefined && !isPathWithin(context.cwd, rule.cwdPrefix)) return false;
  if (rule.pathPrefix !== undefined && !isPathWithin(pathOf(args), rule.pathPrefix)) return false;
  if (rule.commandPrefix !== undefined) {
    const commands = segments ?? commandSegments(context);
    if (commands === null || !commands.some((command) => matchesCommandPrefix(rule.commandPrefix, command))) {
      return false;
    }
  }
  return true;
}

/** Find the first matching rule; the order in the file is the priority. */
export function findAutoApprovalRule(config, context) {
  if (config?.enabled !== true || config.mode === 'review' || !Array.isArray(config.rules)) return null;
  const commands = commandSegments(context);
  if (commands === null) return null;
  let matched = null;
  for (const command of commands) {
    if (command.length === 0 || isSafeReadOnlyCommand(command)) continue;
    const rule = config.rules.find((item) => ruleMatches(item, context, [command]));
    if (rule === undefined) return null;
    if (matched === null) matched = rule;
  }
  return matched;
}

/** Rules that can never be reviewed automatically. */
export function autoApprovalBlocked(config, context) {
  if (config?.humanOnly?.includes(context.toolName) === true) return true;
  if (context.requestedSandbox === 'danger-full-access' && config?.allowFullAccess !== true) return true;
  if (!Array.isArray(config?.humanOnlyPrefixes) || config.humanOnlyPrefixes.length === 0) return false;
  const commands = commandSegments(context);
  if (commands === null) return true;
  return config.humanOnlyPrefixes.some((prefix) => commands.some((command) => matchesCommandPrefix(prefix, command)));
}

/** Build the isolated reviewer payload; no conversation or hidden reasoning. */
export function buildReviewPayload(context, rule, config = {}) {
  const segments = commandSegments(context);
  return {
    mode: config.mode ?? 'rules',
    policy: config.policy ?? '',
    allowFullAccess: config.allowFullAccess === true,
    toolName: context.toolName,
    reason: typeof context.reason === 'string' ? context.reason : '',
    displayReason: typeof context.displayReason === 'string' ? context.displayReason : '',
    cwd: context.cwd ?? null,
    segments,
    currentSandbox: context.currentSandbox ?? null,
    requestedSandbox: context.requestedSandbox ?? null,
    arguments: context.arguments ?? {},
    ...(rule === null ? {} : { rule: {
      id: rule.id,
      description: rule.description ?? '',
      tool: rule.tool,
      ...(rule.commandPrefix === undefined ? {} : { commandPrefix: rule.commandPrefix }),
      ...(rule.pathPrefix === undefined ? {} : { pathPrefix: rule.pathPrefix }),
      ...(rule.cwdPrefix === undefined ? {} : { cwdPrefix: rule.cwdPrefix }),
      ...(rule.sandbox === undefined ? {} : { sandbox: rule.sandbox }),
      allowFullAccess: rule.allowFullAccess === true,
    } }),
  };
}

/** Only an explicit allow verdict is actionable; everything else asks a human. */
export function normalizeReviewVerdict(value) {
  const verdict = value?.verdict === 'allow' ? 'allow' : 'ask';
  const reason = typeof value?.reason === 'string' ? value.reason.trim() : '';
  return { verdict, reason };
}
