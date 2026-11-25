/**
 * Session-scoped allow rules for one approval.
 *
 * Pressing `s` in the approval panel derives one narrow rule from the current
 * call, and `a` previews the same rule for the durable auto-approval file. The
 * TUI stores the rule in memory and the Host mirrors it so later matching calls
 * can be allowed before any approval panel is opened.
 *
 * This module is deliberately the only matcher for those rules: the client and
 * the Host must agree, and a malformed, unparseable, or widened call has to
 * fail closed instead of matching.
 */
import { homedir } from 'node:os';
import { dirname, isAbsolute, parse, resolve } from 'node:path';

import {
  isPathWithin,
  isSafeReadOnlyCommand,
  matchesCommandPrefix,
  normalizeCommand,
  normalizeCommandPrefix,
  splitShellCommands,
  suggestCommandPrefix,
} from './command-rules.js';

export const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access']);

const SANDBOX_RANK = Object.freeze({ 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 });
const MAX_PATH_CHARS = 4_096;
const MAX_PREFIX_TOKENS = 8;
const MAX_TOKEN_CHARS = 256;

/** Normalize slashes and drop a trailing separator except for a root. */
export function normalizeRulePath(value) {
  if (typeof value !== 'string') return '';
  const slashed = value.replace(/\\/gu, '/');
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/u, '') : slashed;
  return trimmed;
}

/** Whether a sandbox mode is one of DSH's documented modes. */
export function isSandboxMode(value) {
  return typeof value === 'string' && SANDBOX_MODES.includes(value);
}

/** The target path in one file tool's parsed arguments. */
export function toolPathOf(args) {
  if (args === null || typeof args !== 'object') return '';
  for (const key of ['path', 'file_path', 'file']) {
    if (typeof args[key] === 'string' && args[key].trim() !== '') return args[key].trim();
  }
  return '';
}

/**
 * Resolve a tool path against the Session workspace for comparison and rules.
 * `~` and `~/...` expand to the user's home directory so the outside-workspace
 * marker and the `w` action work for home-relative targets too. A relative path
 * with no usable cwd stays relative, which keeps matching conservative rather
 * than guessing a directory.
 *
 * @param {unknown} value
 * @param {unknown} cwd
 * @param {string} [home] override for tests
 * @returns {string}
 */
export function resolveRulePath(value, cwd, home = homedir()) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const text = value.trim();
  if (text.length > MAX_PATH_CHARS || text.includes('\u0000')) return '';
  if (text === '~') return normalizeRulePath(home);
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return normalizeRulePath(resolve(home, text.slice(2)));
  }
  // `~user` is not expanded by the harness; keep it literal rather than
  // resolving it against the workspace as if it were a relative path.
  if (text.startsWith('~')) return normalizeRulePath(text);
  if (isAbsolute(text)) return normalizeRulePath(resolve(text));
  if (typeof cwd === 'string' && isAbsolute(cwd)) return normalizeRulePath(resolve(cwd, text));
  return normalizeRulePath(text);
}

/**
 * Whether a path is a filesystem root. Granting a root as a session writable
 * directory would be broader than the approval flow allows, so `w` and the
 * `/sandbox allow-dir` route refuse it.
 */
export function isFilesystemRoot(value) {
  const normalized = normalizeRulePath(typeof value === 'string' ? value : '');
  if (normalized === '' || !isAbsolute(normalized)) return false;
  return normalized === normalizeRulePath(parse(normalized).root);
}

/** The parent directory of one resolved tool path, or empty. */
export function parentDirectoryOf(path) {
  const normalized = normalizeRulePath(path);
  if (normalized === '') return '';
  if (!isAbsolute(normalized)) {
    const slash = normalized.lastIndexOf('/');
    return slash < 0 ? '' : normalized.slice(0, slash) || '';
  }
  return normalizeRulePath(dirname(normalized));
}

/** Whether a resolved target lies outside the workspace root. */
export function isOutsideWorkspace(path, cwd) {
  const target = normalizeRulePath(path);
  const root = normalizeRulePath(typeof cwd === 'string' ? cwd : '');
  if (target === '' || root === '' || !isAbsolute(target) || !isAbsolute(root)) return false;
  return !isPathWithin(target, root);
}

/** The normalized commands in one shell context, or null if unparseable. */
export function commandSegmentsOf(context) {
  const command = typeof context?.arguments?.command === 'string' ? context.arguments.command : '';
  if (command === '') return [];
  const parsed = splitShellCommands(command);
  if (parsed === null) return null;
  return parsed.map(normalizeCommand);
}

function requestedSandboxOf(context) {
  const value = context?.arguments?.sandbox_permissions;
  return isSandboxMode(value) ? value : null;
}

/**
 * Derive one narrow session rule from an approval context.
 *
 * Bash uses the ordered program/subcommand prefix, file tools use the exact
 * path, and `danger-full-access` is carried only because the caller asked for
 * the rule on a prompt that explicitly requested that sandbox.
 *
 * @param {{toolName?: unknown, arguments?: unknown, cwd?: unknown, requestedSandbox?: unknown}} context
 * @returns {{tool: string, commandPrefix?: Array<string|string[]>, pathPrefix?: string, sandbox?: string, allowFullAccess?: boolean}|null}
 */
export function sessionRuleFrom(context) {
  const tool = typeof context?.toolName === 'string' ? context.toolName.trim() : '';
  if (tool === '' || /[\s\u0000]/u.test(tool)) return null;
  const args = context?.arguments;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  const requested = requestedSandboxOf(context) ?? (isSandboxMode(context?.requestedSandbox) ? context.requestedSandbox : null);
  const rule = { tool };
  const command = typeof args.command === 'string' ? args.command : '';
  if (command.trim() !== '') {
    const segments = commandSegmentsOf({ arguments: args });
    if (segments === null) return null;
    const first = segments.find((segment) => segment.length > 0);
    if (first === undefined) return null;
    const prefix = suggestCommandPrefix(first);
    if (prefix.length === 0 || prefix.length > MAX_PREFIX_TOKENS) return null;
    if (prefix.some((token) => typeof token !== 'string' || token.length > MAX_TOKEN_CHARS)) return null;
    // The rule must describe every non-read-only segment, otherwise a later
    // identical call could never match it. A mixed compound line is refused so
    // `s`/`a` never create a rule the matcher would immediately bypass.
    const candidates = segments.filter((segment) => segment.length > 0 && !isSafeReadOnlyCommand(segment));
    if (!candidates.every((segment) => matchesCommandPrefix(prefix, segment))) return null;
    rule.commandPrefix = prefix;
  } else {
    const path = resolveRulePath(toolPathOf(args), context?.cwd);
    if (path === '') return null;
    rule.pathPrefix = path;
  }
  if (requested !== null) {
    rule.sandbox = requested;
    if (requested === 'danger-full-access') rule.allowFullAccess = true;
  }
  return rule;
}

/**
 * Validate one rule received from a client (or read from memory).
 * Unknown or malformed rules are dropped; a rule with neither a command prefix
 * nor a path prefix would match every call and is rejected.
 *
 * @param {unknown} value
 * @returns {{tool: string, commandPrefix?: Array<string|string[]>, pathPrefix?: string, sandbox?: string, allowFullAccess?: boolean}|null}
 */
export function normalizeSessionRule(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const tool = typeof value.tool === 'string' ? value.tool.trim() : '';
  if (tool === '' || /[\s\u0000]/u.test(tool)) return null;
  let commandPrefix = null;
  if (value.commandPrefix !== undefined) {
    commandPrefix = normalizeCommandPrefix(value.commandPrefix);
    if (commandPrefix === null || commandPrefix.length > MAX_PREFIX_TOKENS) return null;
    const flat = commandPrefix.flat();
    if (flat.length > MAX_PREFIX_TOKENS || flat.some((token) => typeof token !== 'string' || token.length > MAX_TOKEN_CHARS)) return null;
  }
  let pathPrefix = null;
  if (value.pathPrefix !== undefined) {
    if (typeof value.pathPrefix !== 'string' || value.pathPrefix.trim() === '') return null;
    if (value.pathPrefix.length > MAX_PATH_CHARS || value.pathPrefix.includes('\u0000')) return null;
    pathPrefix = normalizeRulePath(value.pathPrefix.trim());
  }
  if (commandPrefix === null && pathPrefix === null) return null;
  let sandbox;
  if (value.sandbox !== undefined) {
    if (!isSandboxMode(value.sandbox)) return null;
    sandbox = value.sandbox;
  }
  // A full-access marker only makes sense together with that sandbox; never
  // accept a marker that would silently widen an ordinary rule.
  if (value.allowFullAccess === true && sandbox !== 'danger-full-access') return null;
  const rule = { tool };
  if (commandPrefix !== null) rule.commandPrefix = commandPrefix;
  if (pathPrefix !== null) rule.pathPrefix = pathPrefix;
  if (sandbox !== undefined) rule.sandbox = sandbox;
  // `danger-full-access` always needs the explicit marker, whatever the client
  // sent; it can never be inferred from a reason or a path.
  if (sandbox === 'danger-full-access') rule.allowFullAccess = true;
  return rule;
}

/**
 * Whether one session rule structurally matches one approval context.
 *
 * Compound shell lines require every non-read-only segment to match the
 * prefix, exactly like the durable auto-approval matcher. Unparseable input,
 * a missing command for a command rule, a missing path for a path rule, and
 * an unacknowledged full-access request all fail closed.
 *
 * @param {object} rule
 * @param {{toolName?: unknown, arguments?: unknown, cwd?: unknown, requestedSandbox?: unknown}} context
 * @returns {boolean}
 */
export function sessionRuleMatches(rule, context) {
  if (rule === null || typeof rule !== 'object') return false;
  if (typeof rule.tool !== 'string' || rule.tool !== context?.toolName) return false;
  const args = context?.arguments;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
  const requested = requestedSandboxOf(context) ?? (isSandboxMode(context?.requestedSandbox) ? context.requestedSandbox : null);
  if (requested === 'danger-full-access' && rule.allowFullAccess !== true) return false;
  // A rule derived from a call that requested no wider sandbox must not cover
  // a later escalated call; the human approved exactly that authority.
  if (rule.sandbox !== undefined) {
    if (rule.sandbox !== requested) return false;
  } else if (requested !== null) {
    return false;
  }
  if (rule.commandPrefix !== undefined) {
    const segments = commandSegmentsOf({ arguments: args });
    if (segments === null) return false;
    const candidates = segments.filter((segment) => segment.length > 0 && !isSafeReadOnlyCommand(segment));
    if (candidates.length === 0) return false;
    if (!candidates.every((segment) => matchesCommandPrefix(rule.commandPrefix, segment))) return false;
  } else if (typeof args.command === 'string' && args.command.trim() !== '') {
    // A path-only rule must never match a shell command.
    return false;
  }
  if (rule.pathPrefix !== undefined) {
    const path = resolveRulePath(toolPathOf(args), context?.cwd);
    if (path === '' || !isPathWithin(path, rule.pathPrefix)) return false;
  }
  return true;
}

/** Rank one sandbox mode so a caller can tell escalation from a no-op. */
export function sandboxRank(value) {
  return isSandboxMode(value) ? SANDBOX_RANK[value] : -1;
}

/**
 * Whether a requested mode widens the current mode.
 *
 * @param {unknown} current
 * @param {unknown} requested
 * @returns {boolean}
 */
export function sandboxEscalates(current, requested) {
  if (!isSandboxMode(requested)) return false;
  if (!isSandboxMode(current)) return requested === 'danger-full-access' || requested === 'workspace-write';
  return sandboxRank(requested) > sandboxRank(current);
}

/** One-line description of a session rule for the panel and notes. */
export function describeSessionRule(rule) {
  if (rule === null || typeof rule !== 'object') return '';
  const tool = typeof rule.tool === 'string' ? rule.tool : 'tool';
  const target = Array.isArray(rule.commandPrefix)
    ? rule.commandPrefix.map((token) => (Array.isArray(token) ? token.join('|') : String(token))).join(' ')
    : typeof rule.pathPrefix === 'string'
      ? rule.pathPrefix
      : '';
  const parts = [tool, target === '' ? '' : target, rule.sandbox ?? ''].filter((part) => part !== '');
  if (rule.allowFullAccess === true) parts.push('DANGER full access');
  return parts.join(' · ');
}

/** Stable candidate id for the durable auto-approval file. */
export function sessionRuleId(rule) {
  if (rule === null || typeof rule !== 'object') return 'session';
  const target = Array.isArray(rule.commandPrefix)
    ? rule.commandPrefix.flat().join('-')
    : typeof rule.pathPrefix === 'string' ? rule.pathPrefix : '';
  const raw = `session-${rule.tool ?? 'tool'}-${target}`.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return (raw === '' ? 'session' : raw).slice(0, 48);
}
