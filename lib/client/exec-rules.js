/**
 * Load explicit approval rules for one headless exec run.
 *
 * The file uses the same TOML/JSONC shape as the TUI auto-approval config, so
 * a dispatcher can keep one policy format. `--approval-rules` is explicit, so
 * an omitted `enabled` means enabled; `enabled = false` still disables it.
 */
import { readFile } from 'node:fs/promises';

import { commandSegments, findAutoApprovalRule, normalizeAutoApprovalConfig, ruleMatches } from './auto-approval.js';
import { isSafeReadOnlyCommand } from '../shared/command-rules.js';
import { parseAutoApprovalText } from './auto-approval-config.js';
import { AttachError } from './connection.js';

/**
 * @param {string} path
 * @returns {Promise<ReturnType<typeof normalizeAutoApprovalConfig>>}
 */
export async function loadExecApprovalRules(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new AttachError(
      `cannot read approval rules ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'attach/exec-rules',
    );
  }
  let raw;
  try {
    raw = parseAutoApprovalText(text, path);
  } catch (error) {
    throw new AttachError(
      `cannot parse approval rules ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'attach/exec-rules',
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AttachError(`approval rules ${path} must contain an object`, 'attach/exec-rules');
  }
  const config = normalizeAutoApprovalConfig({ ...raw, enabled: raw.enabled !== false });
  if (config.enabled !== true) {
    throw new AttachError(`approval rules ${path} are disabled`, 'attach/exec-rules');
  }
  return config;
}

/**
 * Match one rule for a headless exec approval.
 *
 * `findAutoApprovalRule` deliberately skips safe read-only commands and has no
 * segment to match for non-shell tools. An explicit exec policy still needs to
 * cover those cases, so they fall back to the same ordered rule list without
 * weakening compound-command matching: if any non-safe segment exists, only
 * the strict finder may decide.
 *
 * @param {ReturnType<typeof normalizeAutoApprovalConfig>} config
 * @param {object} context
 * @returns {ReturnType<typeof findAutoApprovalRule>}
 */
export function findExecApprovalRule(config, context) {
  if (config?.enabled !== true || config.mode === 'review' || !Array.isArray(config.rules)) return null;
  const commands = commandSegments(context);
  if (commands === null) return null;
  const strict = findAutoApprovalRule(config, context);
  if (strict !== null) return strict;
  if (commands.some((command) => command.length > 0 && !isSafeReadOnlyCommand(command))) return null;
  return config.rules.find((rule) => ruleMatches(rule, context)) ?? null;
}
