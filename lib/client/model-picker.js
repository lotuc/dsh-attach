/**
 * Build model-picker rows from the Host catalog.
 *
 * A model with reasoning efforts gets one row per effort instead of silently
 * using only its default. Models without efforts keep a single row.
 */
export function modelPickerItems(catalog) {
  const items = [];
  for (const group of Array.isArray(catalog?.groups) ? catalog.groups : []) {
    if (typeof group?.id !== 'string' || group.id === '') continue;
    for (const model of Array.isArray(group?.models) ? group.models : []) {
      if (typeof model?.id !== 'string' || model.id === '') continue;
      const efforts = (Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : [])
        .filter((effort) => typeof effort === 'string' && effort !== '');
      const defaultEffort = typeof model?.reasoning?.defaultEffort === 'string' ? model.reasoning.defaultEffort : '';
      const choices = efforts.length === 0
        ? ['']
        : [...new Set([defaultEffort, ...efforts].filter((effort) => effort !== ''))];
      for (const effort of choices) {
        const label = `${group.id}/${model.id}${effort === '' ? '' : ` · ${effort}`}${effort !== '' && effort === defaultEffort ? ' (default)' : ''}`;
        items.push({
          value: JSON.stringify({
            provider: group.id,
            model: model.id,
            ...(effort === '' ? {} : { reasoningEffort: effort }),
          }),
          label,
          description: `${model.name ?? model.id}${effort === '' ? '' : ` · effort ${effort}`}`,
        });
      }
    }
  }
  return items;
}
