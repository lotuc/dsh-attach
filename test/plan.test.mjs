import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePlanCommand, planHostLine, planStatusLines } from '../lib/client/plan.js';

test('parses plan actions and keeps free text as a plan instruction', () => {
  assert.deepEqual(parsePlanCommand(''), { kind: 'enter' });
  assert.deepEqual(parsePlanCommand('enter'), { kind: 'enter' });
  assert.deepEqual(parsePlanCommand('on'), { kind: 'enter' });
  assert.deepEqual(parsePlanCommand('off'), { kind: 'exit' });
  assert.deepEqual(parsePlanCommand('exit'), { kind: 'exit' });
  assert.deepEqual(parsePlanCommand('status'), { kind: 'status' });
  assert.deepEqual(parsePlanCommand('approve'), { kind: 'approve' });
  assert.deepEqual(parsePlanCommand('enter inspect tests'), { kind: 'message', message: 'inspect tests' });
  assert.deepEqual(parsePlanCommand('inspect the failing tests'), {
    kind: 'message',
    message: 'inspect the failing tests',
  });
  assert.deepEqual(parsePlanCommand('edit the parser'), {
    kind: 'message',
    message: 'edit the parser',
  });
});

test('maps plan actions to Host command lines', () => {
  assert.equal(planHostLine({ kind: 'enter' }), '/plan');
  assert.equal(planHostLine({ kind: 'exit' }), '/plan off');
  assert.equal(planHostLine({ kind: 'message', message: 'inspect tests' }), '/plan inspect tests');
  assert.equal(planHostLine({ kind: 'status' }), null);
  assert.equal(planHostLine({ kind: 'approve' }), null);
});

test('renders plan status, pending changes and plan review', () => {
  assert.deepEqual(planStatusLines(null), [
    'mode       inactive',
    '',
    'commands   /plan or /plan <message>',
    '',
    'Enter with a message to start planning, for example /plan inspect the failing tests.',
  ]);
  assert.deepEqual(planStatusLines({ active: true, pending: true }, { review: true }), [
    'mode       active',
    'pending    a mode change applies from the next step',
    'review     a plan is waiting for approval in the question panel',
    '',
    'commands   /plan off',
    '',
    'Approve or keep planning in the plan-review panel when the model presents a plan.',
  ]);
});
