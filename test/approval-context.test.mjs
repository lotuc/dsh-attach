import assert from 'node:assert/strict';
import test from 'node:test';

import { approvalExtraSections } from '../lib/client/approval-context.js';

test('approval extras show the target, proposed edit and session context', () => {
  const sections = approvalExtraSections(JSON.stringify({
    path: '/tmp/repo/src/app.js',
    old_string: 'const a = 1;',
    new_string: 'const a = 2;',
  }), {
    sessionId: 's1',
    cwd: '/tmp/repo',
    permission: 'workspace-write',
    provider: 'deepseek',
    model: 'chat',
  });

  assert.deepEqual(sections.map((section) => section.label), [
    'Target',
    'Proposed edit',
    'Context',
  ]);
  assert.equal(sections[0].text, '/tmp/repo/src/app.js');
  assert.match(sections[1].text, /^--- \/tmp\/repo\/src\/app\.js/m);
  assert.match(sections[1].text, /^- const a = 1;/m);
  assert.match(sections[1].text, /^\+ const a = 2;/m);
  assert.match(sections[2].text, /working directory: \/tmp\/repo/);
  assert.match(sections[2].text, /sandbox: workspace-write/);
  assert.match(sections[2].text, /model: deepseek\/chat/);
});

test('approval extras prefer a supplied unified diff', () => {
  const sections = approvalExtraSections(JSON.stringify({
    file_path: 'src/a.js',
    diff: '@@ -1 +1 @@\n-old\n+new',
  }));
  assert.deepEqual(sections.map((section) => section.label), ['Target', 'Proposed diff']);
  assert.match(sections[1].text, /^@@/);
});

test('approval extras stay empty for plain command arguments', () => {
  assert.deepEqual(approvalExtraSections(JSON.stringify({ command: 'npm test' })), []);
  assert.deepEqual(approvalExtraSections('not json'), []);
  assert.deepEqual(approvalExtraSections(''), []);
});
