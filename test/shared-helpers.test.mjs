import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { approvalReasonText } from '../lib/shared/approval.js';
import { resolveDshHome } from '../lib/shared/paths.js';

test('resolveDshHome honors a non-empty DSH_HOME and trims it', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '  /tmp/dsh-home  ' }), '/tmp/dsh-home');
});

test('resolveDshHome falls back to ~/.dsh for missing or blank values', () => {
  const fallback = join(homedir(), '.dsh');
  assert.equal(resolveDshHome({}), fallback);
  assert.equal(resolveDshHome({ DSH_HOME: '' }), fallback);
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), fallback);
});

test('approvalReasonText accepts strings and localized maps', () => {
  assert.equal(approvalReasonText('plain reason'), 'plain reason');
  assert.equal(approvalReasonText({ en: 'allow?', zh: '允许吗？' }), '允许吗？');
  assert.equal(approvalReasonText({ en: 'allow?' }), 'allow?');
  assert.equal(approvalReasonText({ fr: 'autoriser ?' }), 'autoriser ?');
});

test('approvalReasonText ignores blank entries and non-text values', () => {
  assert.equal(approvalReasonText({ zh: '   ', en: 'allow?' }), 'allow?');
  assert.equal(approvalReasonText({ zh: '   ', en: '' }), '');
  assert.equal(approvalReasonText(null), '');
  assert.equal(approvalReasonText(42), '');
});
