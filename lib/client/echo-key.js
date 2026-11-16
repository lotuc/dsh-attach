/** Stable identity for a locally echoed or committed user message. */
export function contentEchoKey(content) {
  if (!Array.isArray(content)) return String(content ?? '').replace(/\[image\]/gu, '');
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
  const images = content.filter((block) => block?.type === 'image').length;
  return `${text}\u0000${images}`;
}
