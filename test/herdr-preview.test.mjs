import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPreviewPaneArgs, parsePreviewPaneId } from '../lib/client/herdr-preview.js';

test('builds managed plugin pane arguments with connection and lifecycle env', () => {
  const args = buildPreviewPaneArgs({
    targetPane: 'w1:p1',
    direction: 'right',
    sessionId: 'child-1',
    parentSessionId: 'parent-1',
    profile: 'desktop',
    endpoint: '/tmp/endpoint.json',
    theme: 'dark',
    dshHome: '/tmp/dsh-home',
    exitAfterSeconds: 15,
  });

  assert.deepEqual(args.slice(0, 6), ['plugin', 'pane', 'open', '--plugin', 'dsh-tui-attach', '--entrypoint']);
  assert.equal(args[6], 'preview');
  assert.ok(args.includes('--placement'));
  assert.ok(args.includes('split'));
  assert.ok(args.includes('--target-pane'));
  assert.ok(args.includes('w1:p1'));
  assert.ok(args.includes('--direction'));
  assert.ok(args.includes('right'));
  assert.ok(args.includes('--no-focus'));
  for (const expected of [
    'DSH_PREVIEW_SESSION_ID=child-1',
    'DSH_PREVIEW_PARENT_ID=parent-1',
    'DSH_ATTACH_PROFILE=desktop',
    'DSH_ATTACH_ENDPOINT=/tmp/endpoint.json',
    'DSH_ATTACH_THEME=dark',
    'DSH_HOME=/tmp/dsh-home',
    'DSH_PREVIEW_RUNNING=1',
    'DSH_ATTACH_PREVIEW_EXIT_AFTER=15',
  ]) {
    assert.ok(args.includes(expected), `missing ${expected}`);
  }
});

test('omits empty optional environment and parses the plugin pane id', () => {
  const args = buildPreviewPaneArgs({
    targetPane: 'w1:p2',
    direction: 'down',
    sessionId: 'child-2',
    parentSessionId: null,
    exitAfterSeconds: 0,
  });
  assert.ok(args.includes('down'));
  assert.ok(!args.some((arg) => arg.startsWith('DSH_ATTACH_PROFILE=')));
  assert.ok(args.includes('DSH_ATTACH_PREVIEW_EXIT_AFTER=0'));

  assert.equal(
    parsePreviewPaneId(JSON.stringify({ result: { plugin_pane: { pane: { pane_id: 'w1:p9' } } } })),
    'w1:p9',
  );
  assert.equal(parsePreviewPaneId('not json'), null);
  assert.equal(parsePreviewPaneId('{}'), null);
});
