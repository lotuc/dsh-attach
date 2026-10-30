/**
 * Extra read-only material for an approval details panel.
 *
 * The Host request carries the tool name and a preview; the raw tool arguments
 * often also contain the target path and a proposed edit. Surfacing those turns
 * "allow this tool" into an informed decision without changing the Host API.
 */

function parseObject(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstString(object, keys) {
  for (const key of keys) {
    if (typeof object?.[key] === 'string' && object[key].trim() !== '') return object[key];
  }
  return '';
}

function prefixed(text, prefix) {
  const lines = String(text ?? '').split('\n');
  return lines.map((line) => `${prefix}${line}`).join('\n');
}

/**
 * Build target/edit/context sections from raw tool arguments.
 *
 * @param {string} rawDetail - JSON tool arguments
 * @param {{cwd?: string, permission?: string|null, provider?: string|null, model?: string|null, sessionId?: string|null}} [context]
 * @returns {Array<{label: string, text: string}>}
 */
export function approvalExtraSections(rawDetail, context = {}) {
  const parsed = parseObject(rawDetail);
  const sections = [];
  if (parsed !== null) {
    const path = firstString(parsed, ['path', 'file_path', 'file']);
    if (path !== '') sections.push({ label: 'Target', text: path });

    const diff = firstString(parsed, ['diff', 'patch']);
    const oldText = firstString(parsed, ['oldText', 'old_string', 'before']);
    const newText = firstString(parsed, ['newText', 'new_string', 'after']);
    const content = firstString(parsed, ['content', 'text']);
    if (diff !== '') {
      sections.push({ label: 'Proposed diff', text: diff });
    } else if (oldText !== '' || newText !== '') {
      const body = [
        `--- ${path === '' ? 'file' : path}`,
        prefixed(oldText === '' ? '(empty)' : oldText, '- '),
        prefixed(newText === '' ? '(empty)' : newText, '+ '),
      ].join('\n');
      sections.push({ label: 'Proposed edit', text: body });
    } else if (path !== '' && content !== '') {
      sections.push({ label: 'Proposed content', text: `--- ${path}\n${prefixed(content, '+ ')}` });
    }
  }

  const contextLines = [];
  if (typeof context.sessionId === 'string' && context.sessionId !== '') contextLines.push(`session: ${context.sessionId}`);
  if (typeof context.cwd === 'string' && context.cwd !== '') contextLines.push(`working directory: ${context.cwd}`);
  if (typeof context.permission === 'string' && context.permission !== '') contextLines.push(`sandbox: ${context.permission}`);
  if (typeof context.provider === 'string' && context.provider !== '' && typeof context.model === 'string' && context.model !== '') {
    contextLines.push(`model: ${context.provider}/${context.model}`);
  }
  if (contextLines.length > 0) sections.push({ label: 'Context', text: contextLines.join('\n') });
  return sections;
}
