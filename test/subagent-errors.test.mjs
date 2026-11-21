import assert from 'node:assert/strict';
import test from 'node:test';

import { subagentControlErrorText } from '../lib/client/subagent-control.js';
import { SUBAGENT_ERROR_TEXT, subagentErrorText } from '../lib/shared/subagent-errors.js';

test('shares one code-to-text table across host and client', () => {
  assert.ok(Object.isFrozen(SUBAGENT_ERROR_TEXT));
  for (const [code, text] of Object.entries(SUBAGENT_ERROR_TEXT)) {
    assert.equal(subagentErrorText(code), text);
  }
  // Both original Host-side and client-only codes survive the merge.
  assert.equal(subagentErrorText('subagent/attachment-invalid'), 'the subagent rejected the message content');
  assert.equal(subagentErrorText('gateway/bad-request'), 'the subagent control request is invalid');
  assert.equal(subagentErrorText('subagent/control-unavailable'), 'this Host cannot read the subagent catalog');
  assert.equal(subagentErrorText('attach/no-session'), 'no session is open');
});

test('falls back without inheriting object keys', () => {
  assert.equal(subagentErrorText('unknown/code', 'fallback text'), 'fallback text');
  assert.equal(subagentErrorText('constructor', 'fallback text'), 'fallback text');
  assert.equal(subagentErrorText(undefined, 'fallback text'), 'fallback text');
  assert.equal(subagentErrorText('unknown/code'), '');
});

test('the client control helper delegates to the shared table', () => {
  assert.equal(subagentControlErrorText({ code: 'attach/no-session' }), 'no session is open');
  assert.equal(
    subagentControlErrorText({ code: 'subagent/control-unavailable' }),
    'this Host cannot read the subagent catalog',
  );
  assert.equal(subagentControlErrorText(new Error('boom'), 'stop'), 'stop failed: boom');
});
