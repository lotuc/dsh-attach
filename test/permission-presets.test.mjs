import assert from 'node:assert/strict';
import test from 'node:test';

import { PERMISSION_PRESETS } from '../lib/client/permission-presets.js';

test('permission presets match the Host command values', () => {
  assert.deepEqual(PERMISSION_PRESETS.map((preset) => preset.value), [
    'read-only',
    'workspace-write',
    'danger-full-access',
    'auto',
  ]);
  assert.ok(PERMISSION_PRESETS.every((preset) => preset.description !== ''));
});
