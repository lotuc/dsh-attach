/**
 * Structured shell-command rules for auto-approval.
 *
 * The harness never treats a whole shell line as a regex. It tokenizes the
 * line, splits compound commands, strips known wrappers, and matches ordered
 * token prefixes. Complex shell constructs that cannot be classified safely
 * (subshells, substitutions, heredocs, loops) are rejected rather than guessed.
 */

const RESERVED = new Set([
  'for', 'while', 'until', 'if', 'then', 'else', 'elif', 'fi',
  'case', 'esac', 'do', 'done', 'function', 'select', 'coproc',
]);

const SAFE_READ_ONLY = new Set([
  'echo', 'printf', 'tail', 'head', 'cat', 'grep', 'egrep', 'fgrep',
  'wc', 'sort', 'uniq', 'cut', 'tr', 'ls', 'pwd', 'date', 'which',
  'true', 'false', 'test', '[', 'sleep', 'mkdir',
]);

/**
 * Split a shell line into simple command token arrays.
 * Returns null for constructs this matcher cannot classify safely.
 * @param {unknown} input
 * @returns {string[][]|null}
 */
export function splitShellCommands(input) {
  const text = String(input ?? '');
  const commands = [];
  let tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  let comment = false;

  const pushToken = () => {
    if (token !== '') {
      tokens.push(token);
      token = '';
    }
  };
  const pushCommand = () => {
    pushToken();
    if (tokens.length > 0) commands.push(tokens);
    tokens = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (comment) {
      if (character === '\n') {
        comment = false;
        pushCommand();
      }
      continue;
    }
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      else token += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\') escaped = true;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '\\' && text[index + 1] === '\n') {
      index += 1;
      continue;
    }
    if (character === '\\' && text[index + 1] === '\r' && text[index + 2] === '\n') {
      index += 2;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '`') return null;
    if (character === '$' && text[index + 1] === '(') return null;
    if (character === '(' || character === ')') return null;
    if (character === '<' && text[index + 1] === '<') return null;
    if (character === '\n') {
      pushCommand();
      continue;
    }
    if (character === ' ' || character === '\t' || character === '\r') {
      pushToken();
      continue;
    }
    if (character === '#') {
      if (token === '' && tokens.length === 0) {
        comment = true;
        continue;
      }
    }
    if (character === '&' && text[index + 1] === '&') {
      pushCommand();
      index += 1;
      continue;
    }
    if (character === '|' && text[index + 1] === '|') {
      pushCommand();
      index += 1;
      continue;
    }
    if (character === '|' && text[index + 1] === '&') {
      pushCommand();
      index += 1;
      continue;
    }
    if (character === ';' || character === '|') {
      pushCommand();
      continue;
    }
    if (character === '&' && !/\d/u.test(text[index + 1] ?? '')) {
      pushCommand();
      continue;
    }
    if (character === '&') {
      token += character;
      continue;
    }
    token += character;
  }
  if (quote !== null || escaped) return null;
  pushCommand();
  for (const command of commands) {
    if (RESERVED.has(command[0])) return null;
  }
  return commands;
}

/**
 * Strip env assignments and common execution wrappers from one simple command.
 * A bare `cd` segment is treated as navigation and returns an empty array.
 * @param {string[]} command
 * @returns {string[]}
 */
export function normalizeCommand(command) {
  if (!Array.isArray(command)) return [];
  let index = 0;
  const skipAssignments = () => {
    while (index < command.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(command[index])) index += 1;
  };
  skipAssignments();
  for (;;) {
    const token = command[index];
    if (token === 'timeout' && index + 1 < command.length) {
      index += 2;
    } else if (token === 'time' || token === 'nohup' || token === 'command' || token === 'builtin') {
      index += 1;
    } else if (token === 'nice') {
      index += 1;
      if (command[index] === '-n') index += 2;
      else if (/^-\d+$/u.test(command[index] ?? '')) index += 1;
    } else if (token === 'stdbuf') {
      index += 1;
      while (/^-[oei]/u.test(command[index] ?? '')) index += 1;
    } else if (token === 'env') {
      index += 1;
      skipAssignments();
    } else {
      break;
    }
    skipAssignments();
  }
  if (command[index] === 'cd') return [];
  return command.slice(index);
}

/**
 * Whether a command begins with one structured prefix.
 * A prefix element may be a string or an array of alternatives.
 * @param {Array<string|string[]>} prefix
 * @param {string[]} command
 * @returns {boolean}
 */
export function matchesCommandPrefix(prefix, command) {
  if (!Array.isArray(prefix) || !Array.isArray(command) || prefix.length === 0 || prefix.length > command.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    const expected = prefix[index];
    if (typeof expected === 'string') {
      if (command[index] !== expected) return false;
    } else if (Array.isArray(expected)) {
      if (!expected.includes(command[index])) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Normalize a user-supplied `commandPrefix`; invalid entries return null.
 * A string is accepted as a whitespace-separated convenience form.
 * @param {unknown} value
 * @returns {Array<string|string[]>|null}
 */
export function normalizeCommandPrefix(value) {
  if (typeof value === 'string') {
    const parts = value.trim().split(/\s+/u).filter(Boolean);
    return parts.length === 0 ? null : parts;
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  const prefix = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') {
      prefix.push(item.trim());
    } else if (Array.isArray(item)) {
      const alternatives = item.filter((part) => typeof part === 'string' && part.trim() !== '').map((part) => part.trim());
      if (alternatives.length === 0) return null;
      prefix.push(alternatives);
    } else {
      return null;
    }
  }
  return prefix;
}

/** Whether a path is the prefix itself or one of its descendants. */
export function isPathWithin(value, prefix) {
  if (typeof value !== 'string' || typeof prefix !== 'string' || prefix === '') return false;
  const normalizedValue = value.replace(/\\/gu, '/').replace(/\/+$/u, '');
  const normalizedPrefix = prefix.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return normalizedValue === normalizedPrefix || normalizedValue.startsWith(`${normalizedPrefix}/`);
}

/** A command whose first token is a built-in read-only command. */
export function isSafeReadOnlyCommand(command) {
  return Array.isArray(command) && command.length > 0 && SAFE_READ_ONLY.has(command[0]);
}
