import assert from 'node:assert/strict';
import test from 'node:test';

import { interruptedResumeRequestId, shouldResumeInterrupted } from '../lib/client/interrupted-resume.js';

test('resumes only a clean interrupted turn once', () => {
  assert.equal(shouldResumeInterrupted({ reason: 'interrupted' }), true);
  assert.equal(shouldResumeInterrupted({ reason: 'completed' }), false);
  assert.equal(shouldResumeInterrupted({ reason: 'interrupted', running: true }), false);
  assert.equal(shouldResumeInterrupted({ reason: 'interrupted', subagent: true }), false);
  assert.equal(shouldResumeInterrupted({ reason: 'interrupted', pending: 1 }), false);
  assert.equal(shouldResumeInterrupted({ reason: 'interrupted', attempted: true }), false);
  assert.equal(shouldResumeInterrupted({ reason: 'interrupted', enabled: false }), false);
});

test('uses a stable idempotency key for a session turn', () => {
  assert.equal(interruptedResumeRequestId('s1', 4), 'attach-resume-s1-4');
  assert.equal(interruptedResumeRequestId('s1', 4), interruptedResumeRequestId('s1', 4));
});
