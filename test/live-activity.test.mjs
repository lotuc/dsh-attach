import assert from 'node:assert/strict';
import test from 'node:test';

import { describeToolActivity, liveActivityLabel } from '../lib/client/live-activity.js';

test('maps running tools to DSH-style live activity labels', () => {
  assert.deepEqual(describeToolActivity('bash', 'npm test'), { kind: 'commands', detail: 'npm test' });
  assert.deepEqual(describeToolActivity('read', 'src/app.js'), { kind: 'read', detail: 'src/app.js' });
  assert.deepEqual(describeToolActivity('edit', 'src/app.js'), { kind: 'edit', detail: 'src/app.js' });
  assert.deepEqual(describeToolActivity('grep', 'retry'), { kind: 'search', detail: 'retry' });
  assert.deepEqual(describeToolActivity('web_fetch', 'https://example.com'), { kind: 'webFetch', detail: 'https://example.com' });
  assert.deepEqual(describeToolActivity('subagent'), { kind: 'subagents', detail: '' });
  assert.deepEqual(describeToolActivity('unknown_tool', ''), { kind: 'preparing', detail: '' });
});

test('renders the live activity phrase with its detail', () => {
  assert.equal(liveActivityLabel('thinking'), 'Analyzing the request');
  assert.equal(liveActivityLabel('preparing'), 'Preparing');
  assert.equal(liveActivityLabel('commands', 'npm test'), 'Running commands · npm test');
  assert.equal(liveActivityLabel('read', 'README.md'), 'Reading files · README.md');
  assert.equal(liveActivityLabel('unknown'), 'Preparing');
});
