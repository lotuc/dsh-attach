import assert from 'node:assert/strict';
import test from 'node:test';

import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';

import {
  localCommandItems,
  mergeHostCommands,
  modelCompletions,
  resumeCompletions,
} from '../lib/client/command-catalog.js';

function fakeClient() {
  const calls = [];
  return {
    calls,
    async request(method) {
      calls.push(method);
      if (method === 'session.list') {
        return {
          items: [
            { sessionId: 'session-a', title: 'Fix tests', cwd: '/work/a', blank: false, origin: undefined },
            { sessionId: 'session-b', title: 'Blank', cwd: '/work/b', blank: true, origin: undefined },
          ],
        };
      }
      if (method === 'job.list') {
        return {
          jobs: [
            { id: 'job-a', kind: 'bash', label: 'npm test', status: 'running' },
            { id: 'job-b', kind: 'bash', label: 'build', status: 'completed' },
          ],
        };
      }
      if (method === 'model.catalog') {
        return {
          groups: [
            { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'flash', name: 'Flash' }, { id: 'pro', name: 'Pro' }] },
          ],
        };
      }
      throw new Error(`unexpected request ${method}`);
    },
  };
}

test('local commands expose grouped navigation', () => {
  const items = localCommandItems(fakeClient());
  for (const name of ['session', 'subagent', 'image', 'job']) {
    assert.ok(items.some((item) => item.name === name), name);
  }
  assert.equal(items.some((item) => item.name === 'job-output'), false, 'legacy aliases stay out of completion');
});

test('local command items expose grouped, resume and model argument completion', async () => {
  const client = fakeClient();
  const items = localCommandItems(client);
  const session = items.find((item) => item.name === 'session');
  const subagent = items.find((item) => item.name === 'subagent');
  const image = items.find((item) => item.name === 'image');
  const job = items.find((item) => item.name === 'job');
  const model = items.find((item) => item.name === 'model');
  const permission = items.find((item) => item.name === 'permission');
  for (const item of [session, subagent, image, job, model, permission]) {
    assert.equal(typeof item.getArgumentCompletions, 'function');
  }

  assert.deepEqual((await session.getArgumentCompletions('')).map((entry) => entry.value), [
    'list',
    'new ',
    'resume ',
    'rename ',
  ]);
  assert.deepEqual(await session.getArgumentCompletions('resume fix'), [
    { value: 'resume session-a', label: 'resume Fix tests', description: '/work/a · session-' },
  ]);
  assert.deepEqual((await image.getArgumentCompletions('')).map((entry) => entry.value), ['paste', 'list', 'clear']);
  assert.deepEqual((await subagent.getArgumentCompletions('preview ')).map((entry) => entry.value), [
    'preview 1',
    'preview 2',
  ]);
  assert.deepEqual((await job.getArgumentCompletions('output ')).map((entry) => entry.value), [
    'output job-a',
    'output job-b',
  ]);
  assert.deepEqual(await model.getArgumentCompletions('pro'), [
    { value: 'deepseek pro', label: 'deepseek/pro', description: 'Pro' },
  ]);
  assert.deepEqual(await resumeCompletions(client, 'nothing'), []);
  assert.deepEqual(await modelCompletions(client, 'nothing'), []);
  assert.deepEqual((await permission.getArgumentCompletions('')).map((entry) => entry.value), [
    'read-only',
    'workspace-write',
    'danger-full-access',
    'auto',
  ]);
  assert.deepEqual((await permission.getArgumentCompletions('w')).map((entry) => entry.value), ['workspace-write']);
});

test('host commands merge after local commands without shadowing local names', () => {
  const client = fakeClient();
  const merged = mergeHostCommands(localCommandItems(client), [
    { name: 'help', description: 'host help' },
    { name: 'compact', description: 'Compact context' },
    { name: 'plan', description: 'Enter plan mode', argumentHint: '<message>' },
  ]);
  assert.equal(merged.filter((item) => item.name === 'help').length, 1);
  assert.equal(merged.find((item) => item.name === 'compact').description, 'Compact context');
  assert.equal(merged.find((item) => item.name === 'plan').argumentHint, '<message>');
});

test('the combined provider suggests slash commands and their arguments', async () => {
  const client = fakeClient();
  const commands = mergeHostCommands(localCommandItems(client), [{ name: 'compact', description: 'Compact context' }]);
  const provider = new CombinedAutocompleteProvider(commands, '/tmp');
  const signal = new AbortController().signal;

  const slash = await provider.getSuggestions(['/co'], 0, 3, { signal });
  assert.ok(slash.items.some((item) => item.value === 'compact'));
  const compact = slash.items.find((item) => item.value === 'compact');
  const applied = provider.applyCompletion(['/co'], 0, 3, compact, slash.prefix);
  assert.equal(applied.lines[0], '/compact ');

  const resumeText = '/session resume ';
  const resume = await provider.getSuggestions([resumeText], 0, resumeText.length, { signal });
  assert.ok(resume.items.some((item) => item.value === 'resume session-a'));

  const jobText = '/job output ';
  const job = await provider.getSuggestions([jobText], 0, jobText.length, { signal });
  const jobItem = job.items.find((item) => item.value === 'output job-a');
  assert.ok(jobItem);
  const appliedJob = provider.applyCompletion([jobText], 0, jobText.length, jobItem, job.prefix);
  assert.equal(appliedJob.lines[0], '/job output job-a');

  const model = await provider.getSuggestions(['/model '], 0, 7, { signal });
  const flash = model.items.find((item) => item.value === 'deepseek flash');
  assert.ok(flash);
  const appliedModel = provider.applyCompletion(['/model '], 0, 7, flash, model.prefix);
  assert.equal(appliedModel.lines[0], '/model deepseek flash');
});

test('completes nested Host subcommands such as /goal', async () => {
  const goal = {
    name: 'goal',
    description: 'Set or view the goal for a long-running task',
    argumentHint: '[<objective>|clear|edit <objective>|pause|resume]',
  };
  const [item] = mergeHostCommands([], [goal]);
  assert.ok(item);
  assert.equal(typeof item.getArgumentCompletions, 'function');
  assert.deepEqual(
    (await item.getArgumentCompletions('')).map((entry) => entry.value),
    ['clear', 'edit ', 'pause', 'resume'],
  );
  assert.deepEqual(
    (await item.getArgumentCompletions('p')).map((entry) => entry.value),
    ['pause'],
  );
});

test('completes Host permission presets', async () => {
  const [item] = mergeHostCommands([], [{
    name: 'permission',
    description: 'Switch the permission preset',
    argumentHint: '<preset>',
  }]);
  assert.deepEqual(
    (await item.getArgumentCompletions('')).map((entry) => entry.value),
    ['read-only', 'workspace-write', 'danger-full-access', 'auto'],
  );
  assert.deepEqual(
    (await item.getArgumentCompletions('w')).map((entry) => entry.value),
    ['workspace-write'],
  );
});
