/**
 * Shared setup and refresh for the TUI's filterable pickers.
 *
 * The session, subagent, model, job and queue pickers all use the same
 * FilterList + PickerPanel + PickerContainer stack. Keeping the wiring here
 * means a new picker only supplies its items, title and optional key handler.
 */
import { FilterList, PickerContainer, PickerPanel } from './panels.js';
import { selectTheme } from './theme.js';

export const DEFAULT_PICKER_OPTIONS = Object.freeze({
  width: '82%',
  maxWidth: 110,
  maxHeight: '80%',
  anchor: 'center',
  margin: 1,
});

/**
 * @param {{
 *   modals: import('./modals.js').ModalHost,
 *   tui: object,
 *   slot?: string,
 *   title: string,
 *   items: Array<object>,
 *   hint?: string,
 *   preview?: (item: object) => string,
 *   onKey?: (data: string) => boolean,
 *   onCancel?: () => void,
 *   maxVisible?: number,
 *   options?: object,
 * }} config
 * @returns {{list: FilterList, panel: PickerPanel, container: PickerContainer, slot: object}}
 */
export function openPicker({
  modals,
  tui,
  slot = 'picker',
  title,
  items,
  hint = '',
  preview,
  onKey,
  onCancel,
  maxVisible = 14,
  options = DEFAULT_PICKER_OPTIONS,
}) {
  const list = new FilterList(items, maxVisible, selectTheme);
  list.onCancel = onCancel;
  const panel = new PickerPanel(title, list, {
    onCancel,
    requestRender: () => tui.requestRender(),
    hint,
    onKey,
    preview,
  });
  const container = new PickerContainer(panel);
  const record = modals.open(slot, container, options);
  return { list, panel, container, slot: record };
}

/**
 * Replace a picker's rows while preserving the selected value when possible.
 * @param {{list: FilterList, panel: PickerPanel}} picker
 * @param {Array<object>} items
 * @param {string} [title]
 */
export function setPickerItems(picker, items, title) {
  const selected = picker.list.getSelectedItem()?.value;
  picker.list.items = items;
  picker.list.setFilter(picker.list.currentQuery);
  if (selected !== undefined) {
    const index = picker.list.filtered.findIndex((item) => item.value === selected);
    if (index >= 0) picker.list.selectedIndex = index;
  }
  if (typeof title === 'string') picker.panel.title = title;
}
