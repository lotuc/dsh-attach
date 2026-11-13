import assert from 'node:assert/strict';
import test from 'node:test';

import { checkRegex, safeRegexTest } from '../lib/shared/regex-safety.js';

test('rejects invalid and super-linear regex patterns', () => {
  assert.equal(checkRegex('[').valid, false);
  assert.equal(checkRegex('(a+)+$').valid, true);
  assert.equal(checkRegex('(a+)+$').safe, false);
  assert.equal(safeRegexTest('(a+)+$', 'aaaaaaaaaaaaaaaa!'), false);
  assert.equal(checkRegex('^npm test$').safe, true);
  assert.equal(safeRegexTest('^npm test$', 'npm test'), true);
  // A simple unanchored deny pattern must not be a false-positive ReDoS.
  assert.equal(checkRegex('rm\\s+-rf\\s+(?:/|~|\\$HOME)').safe, true);
});
