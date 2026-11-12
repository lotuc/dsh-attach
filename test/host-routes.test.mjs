import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { expectRouteError, withAttachHost } from './helpers/attach-host.mjs';

test('session lifecycle routes round-trip through the socket', async () => {
  await withAttachHost(async ({ client, calls }) => {
    const list = await client.request('session.list');
    assert.equal(list.items.length, 2);
    assert.deepEqual(list.items[0], {
      sessionId: 's1',
      title: 'Fixture',
      cwd: '/work',
      updatedAt: 100,
      running: true,
      blank: false,
      parentSessionId: null,
      origin: null,
      agentAvailable: true,
      agentPreset: 'standard',
      model: { provider: 'p', model: 'm' },
      blankHint: false,
    });
    assert.deepEqual(list.items[1], {
      sessionId: 's2',
      title: null,
      cwd: '/projects/demo',
      updatedAt: 200,
      running: false,
      blank: false,
      parentSessionId: 's1',
      origin: 'subagent',
      agentAvailable: false,
      agentPreset: null,
      model: null,
      blankHint: false,
    });

    await expectRouteError(client.request('session.cancel'), 'attach/no-session');
    await expectRouteError(client.request('session.prompt', { text: 'hi' }), 'attach/no-session');
    await expectRouteError(client.request('session.rename', { title: 'x' }), 'attach/no-session');
    await expectRouteError(client.request('session.selectModel', { provider: 'p', model: 'm' }), 'attach/no-session');
    await expectRouteError(client.request('session.open', {}), 'attach/bad-request');

    const frameSeen = once(client, 'frame');
    const opened = await client.request('session.open', { sessionId: 's1' });
    assert.deepEqual(opened, { sessionId: 's1' });
    const [frame] = await frameSeen;
    assert.equal(frame.frame.type, 'snapshot');
    assert.equal(frame.sessionId, 's1');
    const follow = calls.find((call) => call[0] === 'session.follow');
    assert.deepEqual(follow[1].address, { kind: 'session', sessionId: 's1' });
    assert.equal(follow[1].maxMessages, 300);

    const prompted = await client.request('session.prompt', { text: 'hello', mode: 'steer' });
    assert.equal(prompted.accepted, true);
    const prompt = calls.find((call) => call[0] === 'session.prompt')[1];
    assert.equal(prompt.sessionId, 's1');
    assert.equal(prompt.mode, 'steer');
    assert.deepEqual(prompt.content, [{ type: 'text', text: 'hello' }]);
    assert.equal(typeof prompt.clientTimeZone, 'string');

    const images = await client.request('session.prompt', {
      text: '',
      images: [
        { mediaType: 'image/png', data: 'YWJj' },
        { mediaType: 'image/jpeg', data: 'ZGVm', name: 'shot.jpg' },
        { mediaType: 'text/plain', data: 'ignored' },
        { mediaType: 'image/webp', data: '' },
        null,
        { mediaType: 'image/gif', data: 'Z2lm', name: 7 },
      ],
    });
    assert.equal(images.accepted, true);
    const imageCall = calls.filter((call) => call[0] === 'session.prompt').at(-1)[1];
    assert.deepEqual(imageCall.content, [
      { type: 'image', mediaType: 'image/png', data: 'YWJj', name: 'clipboard.png' },
      { type: 'image', mediaType: 'image/jpeg', data: 'ZGVm', name: 'shot.jpg' },
      { type: 'image', mediaType: 'image/gif', data: 'Z2lm', name: 'clipboard.png' },
    ]);

    await expectRouteError(
      client.request('session.prompt', {
        text: '',
        images: Array.from({ length: 9 }, () => ({ mediaType: 'image/png', data: 'YQ==' })),
      }),
      'attach/bad-request',
      /too many images/u,
    );
    await expectRouteError(client.request('session.prompt', { text: '   ' }), 'attach/bad-request', /empty/u);

    const renamed = await client.request('session.rename', { title: '  New title  ' });
    assert.deepEqual(renamed, { sessionId: 's1', title: 'New title' });
    assert.deepEqual(calls.find((call) => call[0] === 'session.rename')[1], {
      sessionId: 's1',
      title: 'New title',
    });
    await expectRouteError(client.request('session.rename', { title: '  ' }), 'attach/bad-request', /title is empty/u);

    const selected = await client.request('session.selectModel', {
      provider: 'p',
      model: 'm',
      reasoningEffort: 'high',
    });
    assert.deepEqual(selected, { selected: { provider: 'p', model: 'm' } });
    assert.deepEqual(calls.find((call) => call[0] === 'session.selectModel')[1], {
      sessionId: 's1',
      provider: 'p',
      model: 'm',
      reasoningEffort: 'high',
    });
    await expectRouteError(client.request('session.selectModel', { provider: '', model: 'm' }), 'attach/bad-request');

    const catalog = await client.request('model.catalog');
    assert.equal(catalog.groups[0].models[0].id, 'm');

    const cancelled = await client.request('session.cancel');
    assert.deepEqual(cancelled, { accepted: true, cancelled: true });
    assert.deepEqual(calls.find((call) => call[0] === 'session.cancel')[1], { sessionId: 's1' });

    assert.deepEqual(await client.request('session.close'), { closed: true });
    await expectRouteError(client.request('session.prompt', { text: 'after close' }), 'attach/no-session');
    await expectRouteError(client.request('session.cancel'), 'attach/no-session');
    await expectRouteError(client.request('session.rename', { title: 'x' }), 'attach/no-session');

    const created = await client.request('session.create', {
      cwd: '/work',
      agentPreset: 'minimal',
      sessionId: 'explicit',
    });
    assert.deepEqual(created, { sessionId: 'created-1' });
    assert.deepEqual(calls.find((call) => call[0] === 'session.create')[1], {
      cwd: '/work',
      agentPreset: 'minimal',
      sessionId: 'explicit',
    });
    await client.request('session.create', { cwd: '', agentPreset: '', sessionId: '' });
    assert.deepEqual(calls.filter((call) => call[0] === 'session.create').at(-1)[1], {});

    assert.deepEqual(await client.request('activity'), { ok: true });
    await expectRouteError(client.request('does.not.exist'), 'attach/unknown-method', /unknown attach method/u);

    const described = await client.request('host.describe');
    for (const capability of [
      'session.fork',
      'session.archive',
      'session.pin',
      'session.presets',
      'jobs',
      'goal.complete',
      'history.pagination',
      'subagent.continue',
      'subagent.interrupt',
    ]) {
      assert.ok(described.host.capabilities.includes(capability), capability);
    }
    assert.equal(described.config.approvals, 'auto');
    assert.equal(described.socketPath, client.descriptor.socketPath);
  });
});

test('session.open replaces env and reports a failed follow pump', async () => {
  await withAttachHost(async ({ client, services, state, calls }) => {
    await client.request('session.open', {
      sessionId: 's1',
      env: {
        HERDR_ENV: '1',
        HERDR_PANE_ID: 'w1:p1',
        HERDR_BIN_PATH: '/bin/herdr',
        PATH: '/client/bin',
        ignored: 'no',
      },
    });
    const merged = await services.shell.resolve({
      command: 'pwd',
      env: { BASE: '1' },
      dshEnv: { DSH_SESSION_ID: 's1' },
    });
    assert.deepEqual(merged.env, {
      BASE: '1',
      HERDR_ENV: '1',
      HERDR_PANE_ID: 'w1:p1',
      HERDR_BIN_PATH: '/bin/herdr',
    });

    await client.request('session.open', { sessionId: 's2' });
    const cleared = await services.shell.resolve({ env: { BASE: '2' }, dshEnv: { DSH_SESSION_ID: 's1' } });
    assert.deepEqual(cleared.env, { BASE: '2' });
    const other = await services.shell.resolve({ env: { BASE: '3' }, dshEnv: { DSH_SESSION_ID: 's2' } });
    assert.deepEqual(other.env, { BASE: '3' });

    await client.request('session.open', { sessionId: 's2', env: { HERDR_ENV: '1' } });
    await client.request('session.close');
    const closed = await services.shell.resolve({ env: { BASE: '4' }, dshEnv: { DSH_SESSION_ID: 's2' } });
    assert.deepEqual(closed.env, { BASE: '4' });

    await client.request('session.open', { sessionId: 'child', parentSessionId: 'parent', mode: 'one-shot' });
    const subagentFollow = calls.filter((call) => call[0] === 'session.follow').at(-1)[1];
    assert.deepEqual(subagentFollow.address, {
      kind: 'subagent',
      parentSessionId: 'parent',
      childSessionId: 'child',
      mode: 'one-shot',
    });

    await client.request('session.open', { sessionId: 'child2', parentSessionId: '', mode: 'bogus' });
    const plainFollow = calls.filter((call) => call[0] === 'session.follow').at(-1)[1];
    assert.deepEqual(plainFollow.address, { kind: 'session', sessionId: 'child2' });

    state.followError = Object.assign(new Error('follow failed'), { code: 'session/follow-failed' });
    const errorSeen = once(client, 'session-error');
    await client.request('session.open', { sessionId: 's3' });
    const [message] = await errorSeen;
    assert.equal(message.sessionId, 's3');
    assert.equal(message.error.code, 'session/follow-failed');
    assert.equal(message.error.message, 'follow failed');
  });
});

test('history pagination, queue edits and jobs go through the socket', async () => {
  await withAttachHost(async ({ client, server, services, state, calls }) => {
    await expectRouteError(client.request('history.events', { beforeSeq: 1 }), 'attach/no-session');
    await expectRouteError(
      server.readHistory({ sessionId: null }, { beforeSeq: 0 }),
      'attach/no-session',
      /no session is open/u,
    );
    await client.request('session.open', { sessionId: 's1' });

    state.historyPage = {
      cursor: 9,
      hasMore: true,
      records: [
        { type: 'event', event: { seq: 5 } },
        { type: 'event', event: { seq: 8 } },
        { type: 'notification', event: { seq: 100 } },
        { type: 'event', event: { seq: -1 } },
      ],
    };
    const page = await client.request('history.events', { beforeSeq: 10 });
    assert.equal(page.records.length, 4);
    assert.equal(page.hasMore, true);
    assert.equal(page.cursor, 9);
    assert.equal(page.oldestSeq, 5);
    assert.equal(page.newestSeq, 8);
    assert.equal(page.beforeSeq, 10);
    assert.deepEqual(calls.find((call) => call[0] === 'session.events')[1], {
      address: { kind: 'session', sessionId: 's1' },
      beforeSeq: 10,
      maxMessages: 300,
    });

    for (const beforeSeq of [undefined, -1, 1.5, '3', null]) {
      await expectRouteError(
        client.request('history.events', { beforeSeq }),
        'attach/bad-request',
        /beforeSeq must be a non-negative safe integer/u,
      );
    }

    assert.deepEqual(
      await client.request('queue.update', { itemId: 'msg-1', action: { kind: 'remove' } }),
      { accepted: true },
    );
    assert.deepEqual(
      await client.request('queue.update', { itemId: 'msg-2', action: { kind: 'steer' } }),
      { accepted: true },
    );
    assert.deepEqual(
      await client.request('queue.update', { itemId: 'msg-3', action: { kind: 'edit', text: 'rewritten' } }),
      { accepted: true },
    );
    assert.deepEqual(calls.filter((call) => call[0] === 'session.updateQueue').at(-1)[1], {
      sessionId: 's1',
      itemId: 'msg-3',
      action: { kind: 'edit', content: [{ type: 'text', text: 'rewritten' }] },
    });
    await expectRouteError(client.request('queue.update', {}), 'attach/bad-request', /itemId is required/u);
    await expectRouteError(
      client.request('queue.update', { itemId: 'x', action: { kind: 'bogus' } }),
      'attach/bad-request',
      /queue action must be/u,
    );
    await expectRouteError(
      client.request('queue.update', { itemId: 'x', action: { kind: 'edit', text: '  ' } }),
      'attach/bad-request',
      /edit text is empty/u,
    );
    const updateQueue = server.ctx.sessionController.updateQueue;
    delete server.ctx.sessionController.updateQueue;
    await expectRouteError(
      client.request('queue.update', { itemId: 'x', action: { kind: 'remove' } }),
      'queue/unavailable',
    );
    server.ctx.sessionController.updateQueue = updateQueue;

    const listed = await client.request('job.list');
    assert.equal(listed.jobs.length, 1);
    assert.equal(listed.jobs[0].id, 'bash-a');
    const read = await client.request('job.read', { jobId: 'bash-a', from: 2 });
    assert.deepEqual(read.chunks, [{ at: 2, text: 'ok' }]);
    assert.equal(read.next, 3);
    assert.equal(read.lossy, false);
    assert.equal(read.job.id, 'bash-a');
    const killed = await client.request('job.kill', { jobId: 'bash-a' });
    assert.equal(killed.outcome, 'requested');
    assert.equal(killed.job.id, 'bash-a');
    assert.deepEqual(calls.find((call) => call[0] === 'jobs.kill'), [
      'jobs.kill',
      'bash-a',
      's1',
      'cancelled by the user',
    ]);

    await expectRouteError(client.request('job.read', { jobId: 'bash-a', from: -1 }), 'attach/bad-request');
    await expectRouteError(client.request('job.read', { jobId: 'bash-a', from: 1.5 }), 'attach/bad-request');
    await expectRouteError(client.request('job.read', {}), 'attach/bad-request', /jobId is required/u);
    await expectRouteError(client.request('job.kill', {}), 'attach/bad-request', /jobId is required/u);
    await expectRouteError(client.request('job.read', { jobId: 'missing' }), 'job/not-found');
    await expectRouteError(client.request('job.kill', { jobId: 'missing' }), 'job/not-found');

    delete services.jobs;
    await expectRouteError(client.request('job.list'), 'job/unavailable');
    const described = await client.request('host.describe');
    assert.equal(described.host.capabilities.includes('jobs'), false);

    await client.request('session.close');
    await expectRouteError(client.request('job.list'), 'attach/no-session');
    await expectRouteError(client.request('job.read', { jobId: 'bash-a' }), 'attach/no-session');
    await expectRouteError(client.request('job.kill', { jobId: 'bash-a' }), 'attach/no-session');
  });
});


test('commands and skills are discovered and executed for the followed session', async () => {
  await withAttachHost(async ({ client, services, calls, ctx }) => {
    const before = await client.request('commands.list');
    assert.deepEqual(before.commands.map((command) => command.name), ['compact', 'plan']);
    assert.equal(before.commands[1].argumentHint, '<message>');
    assert.equal(calls.find((call) => call[0] === 'commands.list')[1], undefined);

    await expectRouteError(client.request('commands.execute', { line: '/compact' }), 'attach/no-session');
    await client.request('session.open', { sessionId: 's1' });
    const listed = await client.request('commands.list');
    assert.equal(listed.commands[0].name, 'compact');
    assert.equal(calls.filter((call) => call[0] === 'commands.list').at(-1)[1].id, 's1');

    // A followed session whose Agent is cold still gets the per-Agent catalog,
    // so completion matches what commands.execute can actually run.
    const liveAgents = services.agents;
    services.agents = { get: () => undefined };
    const cold = await client.request('commands.list');
    assert.equal(calls.filter((call) => call[0] === 'session.resolveAgent').at(-1)[1], 's1');
    assert.deepEqual(cold.commands.map((command) => command.name), ['compact', 'plan']);
    services.agents = liveAgents;

    const executed = await client.request('commands.execute', { line: '  /compact  ' });
    assert.equal(executed.executed, true);
    assert.equal(executed.commandId, 'cmd-1');
    assert.equal(executed.result.text, 'ran /compact');
    await expectRouteError(client.request('commands.execute', { line: 'compact' }), 'attach/bad-request', /must start with/u);

    const commands = services.commands;
    delete services.commands;
    await expectRouteError(client.request('commands.execute', { line: '/compact' }), 'attach/no-commands');
    services.commands = commands;

    const agents = services.agents;
    services.agents = { get: () => undefined };
    await client.request('commands.execute', { line: '/compact' });
    assert.equal(calls.filter((call) => call[0] === 'session.resolveAgent').at(-1)[1], 's1');
    services.agents = { get: () => undefined };
    ctx.sessionController.resolveAgent = async () => ({ error: { code: 'attach/no-agent', message: 'session is gone' } });
    await expectRouteError(
      client.request('commands.execute', { line: '/compact' }),
      'attach/no-agent',
      /session is gone/u,
    );
    services.agents = agents;

    const skillsBefore = await client.request('skill.list');
    assert.equal(skillsBefore.supported, true);
    assert.deepEqual(skillsBefore.skills.map((skill) => skill.name), ['clojure-eval', 'user-only']);
    assert.equal(skillsBefore.complete, true);
    assert.equal(skillsBefore.skills[0].modelInvocable, true);
    assert.equal(skillsBefore.skills[0].whenToUse, 'When a REPL is running');

    const loaded = await client.request('skill.get', { name: 'clojure-eval' });
    assert.equal(loaded.supported, true);
    assert.equal(loaded.skill.content, 'REPL instructions');
    assert.equal(loaded.skill.path, '/skills/clojure-eval/SKILL.md');
    assert.equal(loaded.skill.provider, 'filesystem');
    assert.equal((await client.request('skill.get', { name: 'model-only' })).skill, null);
    assert.equal((await client.request('skill.get', { name: 'missing' })).skill, null);

    const skills = services.skills;
    services.skills = {
      list: async () => skills.list(),
      get: async (name) => skills.get(name),
    };
    const fallback = await client.request('skill.list');
    assert.equal(fallback.supported, true);
    assert.equal(fallback.complete, true);
    assert.deepEqual(fallback.skills.map((skill) => skill.name), ['clojure-eval', 'user-only']);

    ctx.workingDirectory.ensure = async () => {
      throw new Error('cwd unavailable');
    };
    const withBrokenCwd = await client.request('skill.list');
    assert.equal(withBrokenCwd.supported, true);

    services.skills = skills;
    const agentsForSkills = services.agents;
    services.agents = undefined;
    const noAgent = await client.request('skill.list');
    assert.deepEqual(noAgent, { supported: false, complete: false, skills: [] });
    services.agents = agentsForSkills;

    delete services.skills;
    assert.deepEqual(await client.request('skill.list'), { supported: false, complete: false, skills: [] });
    assert.deepEqual(await client.request('skill.get', { name: 'x' }), { supported: false, skill: null });
    services.skills = skills;

    await client.request('session.close');
    await expectRouteError(client.request('skill.list'), 'attach/no-session', /no session is open/u);
    await expectRouteError(client.request('skill.get', { name: 'x' }), 'attach/no-session', /no session is open/u);
  });
});

test('goal read and completion routes use the goal service', async () => {
  await withAttachHost(async ({ client, services, state, calls }) => {
    await expectRouteError(client.request('goal.get'), 'attach/no-session');
    await expectRouteError(client.request('goal.complete'), 'attach/no-session');
    await client.request('session.open', { sessionId: 's1' });

    const current = await client.request('goal.get');
    assert.equal(current.supported, true);
    assert.equal(current.goal.id, 'g1');
    assert.equal(current.goal.activation, 'disarmed');

    state.goalGetError = new Error('goal store down');
    assert.deepEqual(await client.request('goal.get'), { supported: false, goal: null });
    state.goalGetError = null;

    const goals = services.goals;
    delete services.goals;
    assert.deepEqual(await client.request('goal.get'), { supported: false, goal: null });
    await expectRouteError(client.request('goal.complete'), 'attach/unsupported', /does not expose goal completion/u);
    services.goals = goals;

    const completed = await client.request('goal.complete');
    assert.equal(completed.completed, true);
    assert.equal(completed.goal.phase, 'complete');
    assert.equal(completed.goal.revision, 2);
    assert.deepEqual(calls.filter((call) => call[0] === 'goals.complete').at(-1)[2], { id: 'g1', revision: 1 });

    state.goal = null;
    await expectRouteError(client.request('goal.complete'), 'goal/not-found', /no goal is currently set/u);
    state.goal = { id: 'g2', revision: 4, objective: 'next', phase: 'active', activation: 'armed' };

    const agents = services.agents;
    services.agents = { get: () => undefined };
    state.resolveAgentResult = { error: { code: 'attach/no-agent', message: 'cannot resolve session s1' } };
    assert.deepEqual(await client.request('goal.get'), { supported: false, goal: null });
    await expectRouteError(client.request('goal.complete'), 'attach/no-agent', /cannot resolve session s1/u);

    state.resolveAgentResult = {
      agent: { id: 's1', session: { id: 's1' }, resumed: true },
    };
    const resumed = await client.request('goal.complete');
    assert.equal(resumed.completed, true);
    assert.equal(calls.filter((call) => call[0] === 'goals.get').at(-1)[1], 's1');
    services.agents = agents;
  });
});
