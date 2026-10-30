import assert from 'node:assert/strict';
import test from 'node:test';

import { ModalHost } from '../lib/client/modals.js';
import { openPicker, setPickerItems } from '../lib/client/picker-session.js';

function makeTui() {
  return {
    overlays: [],
    focused: null,
    showOverlay(component, options) {
      const handle = { component, options, hidden: false, hide() { this.hidden = true; } };
      this.overlays.push(handle);
      return handle;
    },
    setFocus(target) {
      this.focused = target;
    },
    requestRender() {},
  };
}

const items = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
];

test('openPicker wires FilterList, PickerPanel and a modal slot', () => {
  const tui = makeTui();
  const modals = new ModalHost(tui, () => 'editor');
  const picker = openPicker({
    modals,
    tui,
    title: 'Pick one',
    items,
    hint: 'n new',
    maxVisible: 5,
  });

  assert.equal(picker.list.items, items);
  assert.equal(picker.list.maxVisible, 5);
  assert.equal(picker.panel.title, 'Pick one');
  assert.equal(picker.panel.hint, 'n new');
  assert.equal(picker.slot.name, 'picker');
  assert.equal(modals.has('picker'), true);
  assert.equal(tui.overlays.length, 1);
});

test('setPickerItems preserves the selected value and updates the title', () => {
  const tui = makeTui();
  const modals = new ModalHost(tui, () => 'editor');
  const picker = openPicker({ modals, tui, title: 'Jobs', items });
  picker.list.setSelectedIndex(1);

  setPickerItems(picker, [
    { value: 'c', label: 'Gamma' },
    { value: 'b', label: 'Beta' },
  ], 'Jobs · 2');

  assert.deepEqual(picker.list.items.map((item) => item.value), ['c', 'b']);
  assert.equal(picker.list.getSelectedItem().value, 'b');
  assert.equal(picker.panel.title, 'Jobs · 2');
});
