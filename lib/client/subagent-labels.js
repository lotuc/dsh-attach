/**
 * Merge short catalog labels into active subagent summary rows.
 *
 * Newer Hosts include the label directly in `subagent.summary`. Older Hosts
 * only include the session title, so the client fills the label from
 * `subagent.list` and passes it here.
 *
 * @param {Array<{id: string, label?: string|null}>} active
 * @param {Map<string, string|null>} labels
 * @returns {Array<object>}
 */
export function mergeActiveSubagentLabels(active, labels) {
  return active.map((item) => {
    if (typeof item.label === 'string' && item.label.trim() !== '') return item;
    const label = labels.get(String(item.id));
    if (typeof label !== 'string' || label.trim() === '') return item;
    return { ...item, label: label.trim() };
  });
}
