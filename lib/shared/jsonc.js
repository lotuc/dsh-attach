/**
 * Minimal JSON-with-comments parser for the auto-approval config.
 *
 * The config already has nested arrays of token prefixes; comments and
 * trailing commas make it maintainable without introducing a TOML/YAML
 * dependency. Strings are scanned so `//` and `,` inside them are preserved.
 */

/**
 * Parse a JSONC document.
 * @param {string} text
 * @returns {any}
 */
export function parseJsonc(text) {
  const source = String(text ?? '').replace(/^\uFEFF/u, '');
  return JSON.parse(stripTrailingCommas(stripComments(source)));
}

function stripComments(source) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      out += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"') {
      quote = character;
      out += character;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      out += '\n';
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') out += '\n';
        index += 1;
      }
      index += 1;
      out += ' ';
      continue;
    }
    out += character;
  }
  return out;
}

function stripTrailingCommas(source) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      out += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"') {
      quote = character;
      out += character;
      continue;
    }
    if (character === ',') {
      let lookahead = index + 1;
      while (lookahead < source.length && /\s/u.test(source[lookahead])) lookahead += 1;
      if (source[lookahead] === '}' || source[lookahead] === ']') continue;
    }
    out += character;
  }
  return out;
}
