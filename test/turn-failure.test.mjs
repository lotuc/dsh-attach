import assert from 'node:assert/strict';
import test from 'node:test';

import { attemptFailure, failureText, turnFailure } from '../lib/client/turn-failure.js';

const quota = {
  message: 'Insufficient Balance (request_id: 5b11d0d5)',
  code: 'ACCOUNT_QUOTA',
  status: 402,
};

test('extracts a failed attempt finish reason', () => {
  const failure = attemptFailure({
    stream: [
      { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: quota } } },
    ],
  });
  assert.deepEqual(failure, quota);
  assert.equal(failureText(failure), 'Insufficient Balance (request_id: 5b11d0d5) [ACCOUNT_QUOTA · HTTP 402]');
});

test('extracts the terminal turn failure and tolerates missing fields', () => {
  assert.deepEqual(turnFailure({ reason: { kind: 'error', error: quota } }), quota);
  assert.deepEqual(turnFailure({ reason: { kind: 'error', failure: { code: 'AUTH' } } }), {
    message: '',
    code: 'AUTH',
    status: null,
  });
  assert.equal(failureText({ message: '', code: 'AUTH', status: null }), 'model request failed [AUTH]');
  assert.equal(attemptFailure({ stream: [] }), null);
  assert.equal(turnFailure({ reason: { kind: 'completed' } }), null);
});

test('does not repeat a code already present in the message', () => {
  assert.equal(failureText({ message: 'quota ACCOUNT_QUOTA', code: 'ACCOUNT_QUOTA', status: null }), 'quota ACCOUNT_QUOTA');
});
