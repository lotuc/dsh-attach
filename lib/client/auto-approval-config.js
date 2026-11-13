/**
 * Read/write the auto-approval config.
 *
 * TOML is the default because rules are naturally arrays of tables. Legacy
 * `.json`/`.jsonc` files remain readable for explicit overrides.
 */
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { parseJsonc } from '../shared/jsonc.js';

const TOP_KEYS = {
  allow_full_access: 'allowFullAccess',
  max_auto_approvals: 'maxAutoApprovals',
  timeout_ms: 'timeoutMs',
  human_only: 'humanOnly',
  human_only_prefixes: 'humanOnlyPrefixes',
};

const RULE_KEYS = {
  command_prefix: 'commandPrefix',
  path_prefix: 'pathPrefix',
  cwd_prefix: 'cwdPrefix',
  allow_full_access: 'allowFullAccess',
};

function mapKeys(value, mapping) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[mapping[key] ?? key] = entry;
  }
  return result;
}

function toCamel(raw) {
  const value = mapKeys(raw, TOP_KEYS);
  if (Array.isArray(value.rules)) {
    value.rules = value.rules.map((rule) => mapKeys(rule, RULE_KEYS));
  }
  return value;
}

function toSnake(raw) {
  const reverseTop = Object.fromEntries(Object.entries(TOP_KEYS).map(([snake, camel]) => [camel, snake]));
  const reverseRule = Object.fromEntries(Object.entries(RULE_KEYS).map(([snake, camel]) => [camel, snake]));
  const value = mapKeys(raw, reverseTop);
  if (Array.isArray(value.rules)) {
    value.rules = value.rules.map((rule) => mapKeys(rule, reverseRule));
  }
  return value;
}

/** Parse a TOML or legacy JSON/JSONC config by path extension. */
export function parseAutoApprovalText(text, path = 'auto-approve.toml') {
  if (/\.jsonc?$/iu.test(path)) return parseJsonc(text);
  return toCamel(parseToml(text));
}

/** Serialize the config in TOML for a `.toml` path, else strict JSON. */
export function serializeAutoApprovalText(raw, path = 'auto-approve.toml') {
  if (/\.jsonc?$/iu.test(path)) return `${JSON.stringify(raw, null, 2)}\n`;
  return `${stringifyToml(toSnake(raw))}\n`;
}
