/** Read-only helpers for the pending prompt queue. */
import { oneLine, textOfContent } from './transcript.js';

function queueId(entry, index) {
  const id = entry?.message?.id;
  return typeof id === 'string' && id !== '' ? id : `${entry?.target ?? 'queue'}:${index}`;
}

/** Turn visible inbox entries into FilterList rows. */
export function queueItems(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry, index) => {
    const id = queueId(entry, index);
    const text = oneLine(textOfContent(entry.message?.content), 72) || '(no text)';
    const steering = entry.target === 'next-step';
    return {
      value: id,
      label: `${steering ? '↳ steering' : '› queued'} · ${text}`,
      description: `${entry.label} · ${id}`,
      meta: entry.label,
      entry,
    };
  });
}

/** Read-only sections for one queued message. */
export function queueSections(entry, index = 0) {
  return [
    { label: 'Message', text: textOfContent(entry?.message?.content) || '(no text)' },
    { label: 'Delivery', text: entry?.label ?? 'next turn' },
    { label: 'Item', text: queueId(entry, index) },
  ];
}

/** Extract the display text of one queue entry. */
export function queueText(entry) {
  return textOfContent(entry?.message?.content);
}
