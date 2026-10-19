import assert from 'node:assert/strict';
import test from 'node:test';

import { accent, currentTheme, panelBg, setTheme } from '../lib/client/theme.js';

test('light is the default and uses dark foreground colours', () => {
  setTheme('light');
  assert.equal(currentTheme(), 'light');
  assert.match(accent('x'), /38;5;25m/);
  assert.match(panelBg('x'), /48;5;254m/);
});

test('dark can be selected explicitly', () => {
  setTheme('dark');
  assert.equal(currentTheme(), 'dark');
  assert.match(accent('x'), /38;5;111m/);
  assert.match(panelBg('x'), /48;5;235m/);
  setTheme('light');
});
