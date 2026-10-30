import assert from 'node:assert/strict';
import test from 'node:test';

import { modelPickerItems } from '../lib/client/model-picker.js';

test('creates one row per reasoning effort and marks the default', () => {
  const items = modelPickerItems({
    groups: [{
      id: 'deepseek',
      models: [{
        id: 'chat',
        name: 'Chat',
        reasoning: { efforts: ['low', 'high'], defaultEffort: 'high' },
      }],
    }],
  });

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.label), [
    'deepseek/chat · high (default)',
    'deepseek/chat · low',
  ]);
  assert.deepEqual(JSON.parse(items[0].value), {
    provider: 'deepseek',
    model: 'chat',
    reasoningEffort: 'high',
  });
});

test('keeps a single row for models without efforts', () => {
  const items = modelPickerItems({
    groups: [{ id: 'p', models: [{ id: 'm', name: 'Model' }] }],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'p/m');
  assert.deepEqual(JSON.parse(items[0].value), { provider: 'p', model: 'm' });
});

test('tolerates an empty or malformed catalog', () => {
  assert.deepEqual(modelPickerItems({}), []);
  assert.deepEqual(modelPickerItems(null), []);
  assert.deepEqual(modelPickerItems({ groups: [{ models: [{}] }] }), []);
});
