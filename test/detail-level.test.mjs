import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DETAIL_LEVELS,
  detailFlags,
  nextDetailLevel,
  normalizeDetailLevel,
} from '../lib/client/detail-level.js';

test('cycles compact -> standard -> verbose', () => {
  assert.deepEqual(DETAIL_LEVELS, ['compact', 'standard', 'verbose']);
  assert.equal(nextDetailLevel('compact'), 'standard');
  assert.equal(nextDetailLevel('standard'), 'verbose');
  assert.equal(nextDetailLevel('verbose'), 'compact');
});

test('normalizes unknown settings to the requested fallback', () => {
  assert.equal(normalizeDetailLevel('VERBOSE'), 'verbose');
  assert.equal(normalizeDetailLevel('bogus'), 'standard');
  assert.equal(normalizeDetailLevel('bogus', ''), '');
});

test('maps levels to one coherent fold policy', () => {
  assert.deepEqual(detailFlags('compact'), {
    reasoning: false,
    tools: false,
    steps: false,
    liveWork: false,
    completedWork: false,
  });
  assert.equal(detailFlags('standard').liveWork, true);
  assert.equal(detailFlags('standard').completedWork, false);
  assert.deepEqual(detailFlags('verbose'), {
    reasoning: true,
    tools: true,
    steps: true,
    liveWork: true,
    completedWork: true,
  });
});
