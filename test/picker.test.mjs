import assert from 'node:assert/strict';
import test from 'node:test';

import { stripTerminalSequences } from '@earendil-works/pi-tui';

import { ApprovalPanel, FilterList, LoadingPanel, PickerPanel } from '../lib/client/panels.js';
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

test('renders a loading panel while a list request is in flight', () => {
  const plain = stripTerminalSequences(new LoadingPanel('Sessions', 'Loading sessions…').render(40).join('\n'));
  assert.match(plain, /Sessions/);
  assert.match(plain, /Loading sessions/);
});

test('renders list metadata right-aligned and omits duplicated cwd', () => {
  const list = new FilterList(
    [
      {
        kind: 'group',
        groupKey: 'g',
        value: '__group__:g',
        label: 'Workspace',
        description: '/work · 2 sessions · 1 running',
        meta: '2 sessions · 1 running',
      },
      {
        kind: 'session',
        groupKey: 'g',
        value: 's1',
        depth: 1,
        label: 'Fix tests',
        description: '2m ago · /work · 1/2 agents',
        meta: '2m ago · 1/2 agents',
      },
    ],
    5,
    selectTheme,
  );
  const lines = list.render(60).map((line) => stripTerminalSequences(line).trimEnd());
  assert.ok(lines[0].includes('▾ Workspace'));
  assert.ok(lines[0].endsWith('2 sessions · 1 running'));
  assert.ok(lines[1].includes('Fix tests'));
  assert.ok(lines[1].endsWith('2m ago · 1/2 agents'));
  assert.ok(!lines[1].includes('/work'));
});

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

test('runs navigation shortcuts before entering search mode', () => {
  const list = new FilterList([
    { value: 'a', label: 'alpha' },
    { value: 'b', label: 'beta' },
  ], 5, selectTheme);
  const shortcuts = [];
  const panel = new PickerPanel('Fixture', list, {
    requestRender: () => {},
    onKey: (data) => {
      if (data !== 'n') return false;
      shortcuts.push(data);
      return true;
    },
  });
  panel.handleInput('n');
  assert.deepEqual(shortcuts, ['n']);
  assert.equal(panel.mode, 'nav');
  panel.handleInput('x');
  assert.equal(panel.mode, 'search');
});

test('filters and renders flat session rows without group semantics', () => {
  const list = new FilterList([
    { kind: 'session', flat: true, value: 'a', label: 'alpha', description: 'Main · /a' },
    { kind: 'session', flat: true, value: 'b', label: 'beta', description: 'Other · /b' },
  ], 5, selectTheme);
  list.setFilter('beta');
  assert.deepEqual(list.filtered.map((item) => item.value), ['b']);
  list.setFilter('');
  const lines = list.render(80).map((line) => stripTerminalSequences(line));
  assert.match(lines[0], /^→ ○ alpha/);
  assert.match(lines[0], /Main · \/a/);
});

test('right-aligns flat row metadata after the title and workspace context', () => {
  const list = new FilterList([
    {
      kind: 'session',
      flat: true,
      value: 'a',
      label: 'Fix tests',
      description: 'Main · /work',
      meta: '2m ago · 1/2 agents',
    },
  ], 5, selectTheme);
  const line = stripTerminalSequences(list.render(80)[0]);
  assert.match(line, /Fix tests/);
  assert.match(line, /Main · \/work/);
  assert.match(line, /2m ago · 1\/2 agents$/);
});

test('aligns fixed session columns across rows', () => {
  const list = new FilterList([
    { kind: 'session', flat: true, value: 'a', label: 'A', description: '', columns: [
      { text: 'Main · /work', width: 28, align: 'left' },
      { text: '2m ago', width: 8, align: 'right' },
      { text: '1/2 agents', width: 10, align: 'right' },
    ] },
    { kind: 'session', flat: true, value: 'b', label: 'Longer session', description: '', columns: [
      { text: 'Other · /other', width: 28, align: 'left' },
      { text: '1h ago', width: 8, align: 'right' },
      { text: '3 agents', width: 10, align: 'right' },
    ] },
  ], 5, selectTheme);
  const lines = list.render(88).map((line) => stripTerminalSequences(line));
  const workspaceAt = lines[0].indexOf('Main · /work');
  assert.equal(lines[1].indexOf('Other · /other'), workspaceAt);
  assert.equal(lines[0].indexOf('2m ago'), lines[1].indexOf('1h ago'));
  assert.equal(lines[0].indexOf('1/2 agents') + '1/2 agents'.length, lines[1].indexOf('3 agents') + '3 agents'.length);
  assert.match(lines[0], /1\/2 agents$/);
});

test('renders the selected session path in the footer preview', () => {
  const list = new FilterList([
    {
      kind: 'session',
      flat: true,
      table: true,
      titleWidth: 26,
      value: 'a',
      label: 'A',
      path: '/Users/lotuc/Workspace/repos/lotuc/dsh-tui-attach',
      columns: [
        { text: '…/lotuc/dsh-tui-attach', width: 30, align: 'left', flex: true },
        { text: '2m ago', width: 8, align: 'right' },
        { text: '1/2', width: 10, align: 'right' },
      ],
    },
  ], 5, selectTheme);
  const panel = new PickerPanel('Sessions', list, {
    requestRender: () => {},
    preview: (item) => `path ${item.path}`,
  });
  const text = stripTerminalSequences(panel.render(92).join('\n'));
  assert.match(text, /path \/Users\/lotuc\/Workspace\/repos\/lotuc\/dsh-tui-attach/);
});

test('mouse wheel moves the picker selection', () => {
  const { list, panel } = makePanel();
  assert.equal(list.getSelectedItem()?.value, 'a');
  panel.handleInput('\x1b[<65;10;5M');
  assert.equal(list.getSelectedItem()?.value, 'b');
  panel.handleInput('\x1b[<64;10;5M');
  assert.equal(list.getSelectedItem()?.value, 'a');
});
