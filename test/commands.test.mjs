import assert from 'node:assert/strict';
import test from 'node:test';

import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';

import {
  localCommandItems,
  mergeHostCommands,
  modelCompletions,
  presetCompletions,
  resumeCompletions,
  sessionTargetCompletions,
  skillCommandItems,
  skillPickerItems,
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
            { sessionId: 'session-archived', title: 'Old work', cwd: '/work/c', blank: false, origin: undefined },
          ],
        };
      }
      if (method === 'workspace.list') {
        return { items: [], archivedSessionIds: ['session-archived'], pinnedSessionIds: ['session-a'] };
      }
      if (method === 'session.presets') {
        return {
          supported: true,
          defaultId: 'standard',
          presets: [
            { id: 'standard', name: 'Standard mode', description: 'General work', isDefault: true },
            { id: 'minimal', name: 'Minimal mode', description: 'Minimal', isDefault: false, broken: 'missing service' },
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
      if (method === 'subagent.list') {
        return {
          supported: true,
          items: [
            { kind: 'child', id: 'child-a', label: 'Reviewer', mode: 'continuable', activity: 'running' },
            { kind: 'child', id: 'child-b', label: 'Tester', mode: 'one-shot', activity: 'idle' },
          ],
        };
      }
      if (method === 'skill.list') {
        return {
          skills: [
            { name: 'clojure-eval', description: 'Evaluate Clojure code via nREPL' },
            { name: 'office', description: 'Create and edit Office documents' },
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
  for (const name of ['session', 'subagent', 'parent', 'delegate', 'desktop', 'rewind', 'links', 'image', 'job', 'skills', 'todo', 'detail', 'approvals', 'history', 'goal', 'plan']) {
    assert.ok(items.some((item) => item.name === name), name);
  }
  assert.equal(items.some((item) => item.name === 'job-output'), false, 'legacy aliases stay out of completion');
});

test('local command items expose grouped, resume and model argument completion', async () => {
  const client = fakeClient();
  const items = localCommandItems(client, { sessionId: 's1' });
  const session = items.find((item) => item.name === 'session');
  const subagent = items.find((item) => item.name === 'subagent');
  const image = items.find((item) => item.name === 'image');
  const job = items.find((item) => item.name === 'job');
  const skills = items.find((item) => item.name === 'skills');
  const goal = items.find((item) => item.name === 'goal');
  const plan = items.find((item) => item.name === 'plan');
  const model = items.find((item) => item.name === 'model');
  const permission = items.find((item) => item.name === 'permission');
  for (const item of [session, subagent, image, job, skills, goal, plan, model, permission]) {
    assert.equal(typeof item.getArgumentCompletions, 'function');
  }

  assert.deepEqual((await session.getArgumentCompletions('')).map((entry) => entry.value), [
    'list',
    'new ',
    'resume ',
    'rename ',
    'fork ',
    'archive ',
    'unarchive ',
    'pin ',
    'unpin ',
    'presets',
    'preset ',
  ]);
  assert.deepEqual(await session.getArgumentCompletions('resume fix'), [
    { value: 'resume session-a', label: 'resume Fix tests', description: '/work/a · session-' },
  ]);
  assert.deepEqual(await session.getArgumentCompletions('fork fix'), [
    { value: 'fork session-a', label: 'fork Fix tests', description: '/work/a · session-' },
  ]);
  assert.deepEqual((await session.getArgumentCompletions('archive ')).map((entry) => entry.value), [
    'archive session-a',
  ]);
  assert.deepEqual((await session.getArgumentCompletions('unarchive ')).map((entry) => entry.value), [
    'unarchive session-a',
    'unarchive session-archived',
  ]);
  assert.deepEqual((await session.getArgumentCompletions('preset ')).map((entry) => entry.value), [
    'preset standard',
    'preset minimal',
  ]);
  assert.deepEqual((await session.getArgumentCompletions('new --preset ')).map((entry) => entry.value), [
    'new --preset standard',
    'new --preset minimal',
  ]);
  assert.deepEqual((await image.getArgumentCompletions('')).map((entry) => entry.value), ['paste', 'list', 'clear']);
  assert.deepEqual((await skills.getArgumentCompletions('')).map((entry) => entry.value), ['list', 'show ', 'run ']);
  const detail = items.find((item) => item.name === 'detail');
  assert.deepEqual((await detail.getArgumentCompletions('')).map((entry) => entry.value), ['compact', 'standard', 'verbose']);
  assert.deepEqual(await subagent.getArgumentCompletions('continue chi'), [
    { value: 'continue child-a', label: 'continue Reviewer', description: 'continuable · running' },
    { value: 'continue child-b', label: 'continue Tester', description: 'one-shot · idle' },
  ]);
  assert.deepEqual(await skills.getArgumentCompletions('show clo'), [
    { value: 'show clojure-eval', label: 'show clojure-eval', description: 'Evaluate Clojure code via nREPL' },
  ]);
  assert.deepEqual((await subagent.getArgumentCompletions('')).map((entry) => entry.value), [
    'list',
    'continue ',
    'interrupt ',
    'stop ',
    'cancel ',
    'preview ',
    'parent',
    'peek',
  ]);
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
  assert.deepEqual((await goal.getArgumentCompletions('')).map((entry) => entry.value), [
    'status',
    'create ',
    'edit ',
    'pause',
    'resume',
    'complete',
    'clear',
  ]);
  assert.deepEqual((await goal.getArgumentCompletions('c')).map((entry) => entry.value), [
    'create ',
    'complete',
    'clear',
  ]);
  assert.deepEqual((await plan.getArgumentCompletions('')).map((entry) => entry.value), [
    'status',
    'enter ',
    'exit',
    'approve',
  ]);
  assert.deepEqual((await plan.getArgumentCompletions('e')).map((entry) => entry.value), ['enter ', 'exit']);
});

test('preset and archived-session completions come from Host routes', async () => {
  const client = fakeClient();
  assert.deepEqual((await presetCompletions(client, 'sta')).map((entry) => entry.value), ['preset standard']);
  assert.deepEqual(
    (await presetCompletions(client, '', { subcommand: 'new --preset' })).map((entry) => entry.value),
    ['new --preset standard', 'new --preset minimal'],
  );
  assert.deepEqual(
    (await sessionTargetCompletions(client, '', { archived: 'only' })).map((entry) => entry.value),
    ['session-archived'],
  );
  assert.deepEqual(
    (await sessionTargetCompletions(client, '', { archived: 'exclude' })).map((entry) => entry.value),
    ['session-a'],
  );
  assert.deepEqual(
    (await sessionTargetCompletions(client, '', { archived: 'all' })).map((entry) => entry.value),
    ['session-a', 'session-archived'],
  );
  assert.deepEqual(
    await presetCompletions({ request: async () => { throw new Error('offline'); } }, ''),
    [],
  );
  const unsupported = { request: async () => ({ supported: false, presets: [] }) };
  assert.deepEqual(await presetCompletions(unsupported, ''), []);
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
  assert.equal(merged.find((item) => item.name === 'plan').argumentHint, '[status|enter [message]|exit]');
});

test('skill names become slash commands unless a command already owns the name', () => {
  const items = skillCommandItems(
    [
      { name: 'clojure-eval', description: 'Evaluate Clojure' },
      { name: 'skills', description: 'Collides with the local skill group' },
      { name: 'bad name', description: 'invalid' },
    ],
    new Set(['skills']),
  );
  assert.deepEqual(items, [{ name: 'clojure-eval', description: 'skill · Evaluate Clojure' }]);
  const enriched = skillCommandItems([{ name: 'pdf', description: 'Read PDFs', source: 'user-dsh', argumentHint: '[file]' }]);
  assert.deepEqual(enriched, [{
    name: 'pdf',
    description: 'skill · user-dsh · Read PDFs',
    argumentHint: '[file]',
  }]);
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


test('skill picker rows expose source, model policy and argument hints', () => {
  const items = skillPickerItems([
    { name: 'pdf', description: 'Read PDFs', source: 'project-dsh', modelInvocable: true, argumentHint: '[file]' },
    { name: 'notes', description: 'Project notes', source: 'user-dsh', modelInvocable: false },
  ]);
  assert.equal(items[0].value, 'pdf');
  assert.equal(items[0].label, 'pdf [file]');
  assert.equal(items[0].meta, 'project · model · [file]');
  assert.equal(items[1].meta, 'user · user-only');
  assert.equal(items[1].skill.name, 'notes');
});
