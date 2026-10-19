import assert from 'node:assert/strict';
import test from 'node:test';

import { ApprovalPanel, FilterList, PickerPanel } from '../lib/client/panels.js';
import { selectTheme } from '../lib/client/theme.js';

function makePanel() {
  const list = new FilterList(
    [
      { value: 'a', label: 'alpha', description: 'first' },
      { value: 'b', label: 'beta', description: 'second' },
      { value: 'c', label: 'gamma', description: 'third' },
    ],
    5,
    selectTheme,
  );
  const events = { selected: [], cancelled: 0, renders: 0 };
  list.onSelect = (item) => events.selected.push(item.value);
  const panel = new PickerPanel('Fixture', list, {
    onCancel: () => { events.cancelled += 1; },
    requestRender: () => { events.renders += 1; },
  });
  return { list, panel, events };
}

test('ctrl+p/n, CSI-u ctrl keys and arrows move the cursor', () => {
  const { list, panel } = makePanel();
  assert.equal(list.getSelectedItem()?.value, 'a');
  panel.handleInput('\x0e'); // raw Ctrl+N
  assert.equal(list.getSelectedItem()?.value, 'b');
  panel.handleInput('\x1b[110;5u'); // Kitty Ctrl+N
  assert.equal(list.getSelectedItem()?.value, 'c');
  panel.handleInput('\x10'); // raw Ctrl+P
  assert.equal(list.getSelectedItem()?.value, 'b');
  panel.handleInput('\x1b[112;5u'); // Kitty Ctrl+P
  assert.equal(list.getSelectedItem()?.value, 'a');
  panel.handleInput('\x1b[B'); // Down
  assert.equal(list.getSelectedItem()?.value, 'b');
  panel.handleInput('\x1b[A'); // Up
  assert.equal(list.getSelectedItem()?.value, 'a');
});

test('j and k are ordinary search characters, not navigation', () => {
  const { list, panel } = makePanel();
  panel.handleInput('j');
  assert.equal(panel.mode, 'search');
  assert.equal(panel.query, 'j');
  assert.equal(list.getSelectedItem(), null);
});

test('typing enters search mode and filters incrementally', () => {
  const { list, panel, events } = makePanel();
  panel.handleInput('b');
  assert.equal(panel.mode, 'search');
  assert.equal(panel.query, 'b');
  assert.equal(list.getSelectedItem()?.value, 'b');
  panel.handleInput('e');
  assert.equal(panel.query, 'be');
  assert.equal(list.getSelectedItem()?.value, 'b');
  panel.handleInput('\x7f'); // Backspace
  assert.equal(panel.query, 'b');
  panel.handleInput('\x15'); // Ctrl+U
  assert.equal(panel.query, '');
  panel.handleInput('\x1b'); // Esc closes even from search
  assert.equal(events.cancelled, 1);
});

test('renders localized approval reasons, never [object Object]', () => {
  const panel = new ApprovalPanel(
    {
      toolName: 'bash',
      displayReason: { en: 'Allow this command?', zh: '允许这个操作吗？' },
      reason: 'fallback',
    },
    'echo hi',
    () => {},
  );
  const text = panel.render(80).join('\n');
  assert.match(text, /允许这个操作吗/);
  assert.doesNotMatch(text, /object Object/);
});

test('kitty-encoded escape closes the picker', () => {
  const { panel, events } = makePanel();
  panel.handleInput('\x1b[27u');
  assert.equal(events.cancelled, 1);
  panel.handleInput('a');
  panel.handleInput('\x1b[27;1u');
  assert.equal(events.cancelled, 2);
});

test('slash starts search and enter selects', () => {
  const { panel, events } = makePanel();
  panel.handleInput('/');
  assert.equal(panel.mode, 'search');
  panel.handleInput('g');
  assert.equal(panel.query, 'g');
  panel.handleInput('\r');
  assert.deepEqual(events.selected, ['c']);
});

test('filters across labels, descriptions and values', () => {
  const { list } = makePanel();
  list.setFilter('sec');
  assert.equal(list.getSelectedItem()?.value, 'b');
  list.setFilter('thi');
  assert.equal(list.getSelectedItem()?.value, 'c');
  list.setFilter('zzz');
  assert.equal(list.getSelectedItem(), null);
  list.setFilter('');
  assert.equal(list.getSelectedItem()?.value, 'a');
});

test('groups sessions and collapses by workspace', () => {
  const items = [
    { kind: 'group', value: '__group__:g', groupKey: 'g', label: 'Workspace A', description: '/a' },
    { kind: 'session', value: 's1', groupKey: 'g', label: 'One', description: 'first' },
    { kind: 'group', value: '__group__:h', groupKey: 'h', label: 'Workspace B', description: '/b' },
    { kind: 'session', value: 's2', groupKey: 'h', label: 'Two', description: 'second' },
  ];
  const list = new FilterList(items, 10, selectTheme);
  assert.equal(list.filtered.length, 4);
  assert.equal(list.getSelectedItem()?.groupKey, 'g');
  list.select(); // Enter on the group header collapses A
  assert.equal(list.filtered.some((item) => item.value === 's1'), false);
  assert.equal(list.getSelectedItem()?.groupKey, 'g');
  list.select(); // expand again
  assert.equal(list.filtered.some((item) => item.value === 's1'), true);

  list.setFilter('Two');
  assert.equal(list.filtered.some((item) => item.value === 's2'), true);
  assert.equal(list.filtered.some((item) => item.groupKey === 'h' && item.kind === 'group'), true);
  assert.equal(list.filtered.some((item) => item.value === 's1'), false);

  list.setFilter('Workspace A');
  assert.equal(list.filtered.some((item) => item.value === 's1'), true);
  assert.equal(list.filtered.some((item) => item.value === 's2'), false);
});

test('escape in navigation cancels the picker', () => {
  const { panel, events } = makePanel();
  panel.handleInput('\x1b');
  assert.equal(events.cancelled, 1);
});
