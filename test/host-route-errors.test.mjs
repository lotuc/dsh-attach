import assert from 'node:assert/strict';
import test from 'node:test';

import { expectRouteError, withAttachHost } from './helpers/attach-host.mjs';

test('workspace and preset discovery degrades when optional services are absent', async () => {
  await withAttachHost(async ({ client, services, state }) => {
    assert.deepEqual(await client.request('workspace.list'), {
      items: [{ workspaceId: 'w1', title: 'Work', path: '/work', sessionIds: ['s1'] }],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    });

    state.workspaceBaseline = null;
    assert.deepEqual(await client.request('workspace.list'), {
      items: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    });

    state.workspaceFollowError = new Error('workspace view failed');
    assert.deepEqual(await client.request('workspace.list'), {
      items: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    });
    state.workspaceFollowError = null;
    state.workspaceBaseline = {
      items: [{ workspaceId: 'w1', title: 'Work', path: '/work', sessionIds: ['s1'] }],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    };

    const workspace = services.workspaceController;
    delete services.workspaceController;
    assert.deepEqual(await client.request('workspace.list'), {
      items: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    });
    await expectRouteError(client.request('session.archive', { sessionId: 's1' }), 'session/archive-unavailable');
    await expectRouteError(client.request('session.unarchive', { sessionId: 's1' }), 'session/archive-unavailable');
    await expectRouteError(client.request('session.pin', { sessionId: 's1' }), 'session/pin-unavailable');
    await expectRouteError(client.request('session.unpin', { sessionId: 's1' }), 'session/pin-unavailable');
    services.workspaceController = workspace;

    const described = await client.request('host.describe');
    for (const capability of ['session.archive', 'session.pin', 'session.presets', 'session.fork']) {
      assert.ok(described.host.capabilities.includes(capability), capability);
    }

    assert.deepEqual(await client.request('session.presets'), {
      supported: true,
      defaultId: 'standard',
      presets: [
        { id: 'standard', name: 'Standard mode', description: 'General work', isDefault: true },
        { id: 'minimal', name: null, description: 'Minimal mode', isDefault: false },
        { id: 'broken', name: 'Broken', description: null, isDefault: false, broken: 'missing service' },
      ],
    });

    const presets = services.agentPresets;
    services.agentPresets = { list: async () => state.presets };
    const listed = await client.request('session.presets');
    assert.equal(listed.supported, true);
    assert.equal(listed.defaultId, undefined);
    assert.deepEqual(listed.presets.map((preset) => preset.id), ['standard', 'minimal', 'broken']);

    services.agentPresets = {
      async remoteExportList() {
        throw new Error('registry unavailable');
      },
    };
    await expectRouteError(
      client.request('session.presets'),
      'attach/presets-unavailable',
      /cannot read the agent-preset catalog: registry unavailable/u,
    );

    delete services.agentPresets;
    assert.deepEqual(await client.request('session.presets'), { supported: false, presets: [] });
    services.agentPresets = presets;
  });
});

test('fork, archive, pin and preset routes target the followed session', async () => {
  await withAttachHost(async ({ client, server, services, calls }) => {
    await client.request('session.open', { sessionId: 's1' });

    assert.deepEqual(await client.request('session.fork', { atSeq: 0, allowMigration: true }), {
      sessionId: 'fork-1',
    });
    assert.deepEqual(calls.filter((call) => call[0] === 'session.fork').at(-1)[1], {
      sessionId: 's1',
      atSeq: 0,
      allowMigration: true,
    });
    await client.request('session.fork', { sessionId: 's2' });
    assert.deepEqual(calls.filter((call) => call[0] === 'session.fork').at(-1)[1], { sessionId: 's2' });
    await expectRouteError(client.request('session.fork', { sessionId: 's1', atSeq: -1 }), 'attach/bad-request');
    await expectRouteError(client.request('session.fork', { sessionId: 's1', atSeq: 1.5 }), 'attach/bad-request');

    assert.deepEqual(await client.request('session.archive', { sessionId: 's1', stopActivity: true }), {
      archivedSessionIds: ['s1'],
    });
    assert.deepEqual(calls.filter((call) => call[0] === 'workspace.archiveSession').at(-1)[1], {
      sessionId: 's1',
      stopActivity: true,
    });
    assert.deepEqual(await client.request('session.unarchive', { sessionId: 's1' }), { archivedSessionIds: [] });
    assert.deepEqual(await client.request('session.pin', { sessionId: 's1' }), { pinnedSessionIds: ['s1'] });
    assert.deepEqual(await client.request('session.unpin', { sessionId: 's1' }), { pinnedSessionIds: [] });
    assert.deepEqual(await client.request('session.archive', {}), { archivedSessionIds: ['s1'] });
    assert.deepEqual(await client.request('session.pin', {}), { pinnedSessionIds: ['s1'] });

    const fork = server.ctx.sessionController.fork;
    delete server.ctx.sessionController.fork;
    await expectRouteError(client.request('session.fork', {}), 'session/fork-unavailable');
    server.ctx.sessionController.fork = fork;

    const workspace = services.workspaceController;
    delete services.workspaceController;
    await expectRouteError(client.request('session.archive', {}), 'session/archive-unavailable');
    await expectRouteError(client.request('session.unarchive', {}), 'session/archive-unavailable');
    await expectRouteError(client.request('session.pin', {}), 'session/pin-unavailable');
    await expectRouteError(client.request('session.unpin', {}), 'session/pin-unavailable');
    services.workspaceController = workspace;

    await client.request('session.close');
    await expectRouteError(client.request('session.fork', {}), 'attach/bad-request', /sessionId is required/u);
    await expectRouteError(client.request('session.archive', {}), 'attach/bad-request', /sessionId is required/u);
    await expectRouteError(client.request('session.pin', {}), 'attach/bad-request', /sessionId is required/u);
  });
});

test('subagent catalog routes summarize, list and degrade', async () => {
  await withAttachHost(async ({ client, services, state, calls }) => {
    await expectRouteError(client.request('subagent.summary', {}), 'attach/bad-request', /sessionId is required/u);
    state.sessionItems = [
      { sessionId: 's1', running: true, projections: { values: { title: 'Root' } } },
      {
        sessionId: 'child-1',
        parentSessionId: 's1',
        origin: 'subagent',
        running: true,
        projections: { values: { title: 'Long task prompt' } },
      },
      {
        sessionId: 'child-2',
        parentSessionId: 's1',
        origin: 'subagent',
        running: false,
        projections: { values: { title: 'Idle child' } },
      },
    ];
    const summary = await client.request('subagent.summary', { sessionId: 's1' });
    assert.equal(summary.supported, true);
    assert.equal(summary.total, 2);
    assert.equal(summary.running, 1);
    assert.deepEqual(summary.active, [
      { id: 'child-1', parentSessionId: 's1', title: 'Long task prompt', label: 'Reviewer' },
    ]);
    const catalogCalls = calls.filter((call) => call[0] === 'subagents.listChildren').length;
    const cached = await client.request('subagent.summary', { sessionId: 's1' });
    assert.equal(cached.active[0].label, 'Reviewer');
    assert.equal(calls.filter((call) => call[0] === 'subagents.listChildren').length, catalogCalls);

    state.sessionItems.push({
      sessionId: 'child-3',
      parentSessionId: 's1',
      origin: 'subagent',
      running: true,
      projections: { values: { title: 'Third child' } },
    });
    const listChildren = services.subagents.listChildren;
    services.subagents.listChildren = async () => {
      throw new Error('catalog unavailable');
    };
    const failedLabel = await client.request('subagent.summary', { sessionId: 's1' });
    assert.equal(failedLabel.active.find((item) => item.id === 'child-3').label, undefined);
    services.subagents.listChildren = async () => [{ id: 'child-3', label: 'Late label' }];
    const retried = await client.request('subagent.summary', { sessionId: 's1' });
    assert.equal(retried.active.find((item) => item.id === 'child-3').label, 'Late label');
    services.subagents.listChildren = listChildren;

    await expectRouteError(client.request('subagent.children', {}), 'attach/bad-request', /sessionId is required/u);
    const children = await client.request('subagent.children', { sessionId: 's1' });
    assert.equal(children.supported, true);
    assert.equal(children.directOnly, false);
    assert.deepEqual(children.control, { continue: true, interrupt: true });
    assert.deepEqual(children.items.map((item) => item.id), ['child-1']);

    const runtime = services.subagents;
    delete services.subagents;
    assert.deepEqual(await client.request('subagent.children', { sessionId: 's1' }), {
      supported: false,
      items: [],
    });
    assert.deepEqual(await client.request('subagent.list', { sessionId: 's1' }), { supported: false, items: [] });
    services.subagents = runtime;

    services.subagents = {
      async listChildren() {
        return Array.from({ length: 3 }, (_, index) => ({
          id: `direct-${index}`,
          mode: 'continuable',
          label: `Direct ${index}`,
        }));
      },
    };
    const direct = await client.request('subagent.children', { sessionId: 's1' });
    assert.equal(direct.supported, true);
    assert.equal(direct.directOnly, true);
    assert.equal(direct.items.length, 3);
    assert.deepEqual(direct.control, { continue: false, interrupt: false });
    assert.equal(direct.items[0].parentId, 's1');
    assert.equal(direct.items[0].activity, 'inactive');
    assert.equal(direct.items[0].canContinue, false);

    services.subagents = {
      async listChildren() {
        throw new Error('catalog failed');
      },
    };
    assert.deepEqual(await client.request('subagent.children', { sessionId: 's1' }), {
      supported: false,
      items: [],
    });

    services.subagents = {
      async listDescendants() {
        return [
          { kind: 'child', id: 'child-1', parentId: 's1', depth: 1, mode: 'continuable', activity: 'running' },
          { kind: 'link', id: 'link-1', parentId: 's1', depth: 1 },
          { kind: 'child', id: 'child-2', parentId: 'child-1', depth: 2, mode: 'one-shot', activity: 'inactive' },
        ];
      },
    };
    const listed = await client.request('subagent.list', { sessionId: 's1' });
    assert.equal(listed.supported, true);
    assert.deepEqual(listed.items.map((item) => item.id), ['child-1', 'child-2']);

    services.subagents = {
      async listDescendants() {
        throw new Error('lineage unavailable');
      },
    };
    assert.deepEqual(await client.request('subagent.list', { sessionId: 's1' }), { supported: false, items: [] });
  });
});

test('subagent continuation and interruption map runtime failures', async () => {
  await withAttachHost(async ({ client, services, state, calls }) => {
    await expectRouteError(client.request('subagent.continue', { childId: 'child-1', text: 'go' }), 'attach/no-session');
    await expectRouteError(client.request('subagent.interrupt', { childId: 'child-1' }), 'attach/no-session');
    await client.request('session.open', { sessionId: 's1' });

    const runtime = services.subagents;
    const originalPrompt = runtime.prompt;
    const originalSendMessage = runtime.sendMessage;
    const originalInterruptByParent = runtime.interruptByParent;
    const originalInterrupt = runtime.interrupt;
    services.subagents = { ...runtime, prompt: undefined, sendMessage: undefined };
    assert.equal((await client.request('subagent.continue', { childId: 'child-1', text: 'go' })).supported, false);
    services.subagents = { ...runtime, interruptByParent: undefined, interrupt: undefined };
    assert.equal((await client.request('subagent.interrupt', { childId: 'child-1' })).supported, false);
    services.subagents = runtime;

    await expectRouteError(client.request('subagent.continue', { text: 'go' }), 'attach/bad-request', /childId/u);
    await expectRouteError(client.request('subagent.continue', { childId: 'child-1' }), 'attach/bad-request', /text/u);
    await expectRouteError(client.request('subagent.interrupt', {}), 'attach/bad-request', /childId/u);

    state.subagentRows = [{ kind: 'child', id: 'child-1', parentId: 's1', mode: 'one-shot', activity: 'inactive' }];
    await expectRouteError(
      client.request('subagent.continue', { childId: 'child-1', text: 'go' }),
      'subagent/not-resumable',
      /continuable/u,
    );
    state.subagentRows = [{ kind: 'child', id: 'child-1', parentId: 'offline-parent', mode: 'continuable' }];
    await expectRouteError(
      client.request('subagent.continue', { childId: 'child-1', text: 'go' }),
      'subagent/parent-unavailable',
      /parent is not live/u,
    );

    state.subagentRows = [
      { kind: 'child', id: 'child-1', parentId: 's1', depth: 1, mode: 'continuable', activity: 'running' },
    ];
    const continued = await client.request('subagent.continue', {
      childId: 'child-1',
      text: ' keep going ',
      delivery: 'steer',
    });
    assert.deepEqual(continued, { supported: true, accepted: true, messageId: 'message-1' });
    const prompt = calls.filter((call) => call[0] === 'subagents.prompt').at(-1)[1];
    assert.equal(prompt.parentSessionId, 's1');
    assert.equal(prompt.childSessionId, 'child-1');
    assert.equal(prompt.mode, 'continuable');
    assert.equal(prompt.delivery, 'steer');
    assert.deepEqual(prompt.content, [{ type: 'text', text: 'keep going' }]);
    assert.equal(typeof prompt.requestId, 'string');
    assert.equal(typeof prompt.clientTimeZone, 'string');

    const RealDateTimeFormat = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function unavailableClock() {
      throw new Error('clock unavailable');
    };
    try {
      assert.deepEqual(
        await client.request('subagent.continue', { childId: 'child-1', text: 'without a clock' }),
        { supported: true, accepted: true, messageId: 'message-1' },
      );
      const withoutZone = calls.filter((call) => call[0] === 'subagents.prompt').at(-1)[1];
      assert.equal('clientTimeZone' in withoutZone, false);
    } finally {
      Intl.DateTimeFormat = RealDateTimeFormat;
    }

    const codes = [
      ['UNAUTHORIZED', 'subagent/unauthorized', /does not authorize/u],
      ['NOT_RESUMABLE', 'subagent/not-resumable', /continuable/u],
      ['PARENT_UNAVAILABLE', 'subagent/parent-unavailable', /parent is not live/u],
      ['CANCELLED', 'gateway/cancelled', /cancelled/u],
      ['ACTIVATION_LIMIT_REACHED', 'subagent/delivery-unavailable', /cannot accept/u],
      ['DRAINING', 'subagent/delivery-unavailable', /cannot accept/u],
      ['custom-code', 'custom-code', /runtime failure/u],
      ['', 'subagent/continue-failed', /runtime failure/u],
    ];
    for (const [rawCode, expectedCode, message] of codes) {
      services.subagents.prompt = async () => {
        throw Object.assign(new Error('runtime failure'), { code: rawCode });
      };
      await expectRouteError(
        client.request('subagent.continue', { childId: 'child-1', text: 'again' }),
        expectedCode,
        message,
      );
    }
    services.subagents.prompt = originalPrompt;

    services.subagents.prompt = undefined;
    assert.deepEqual(await client.request('subagent.continue', { childId: 'child-1', text: 'legacy' }), {
      supported: true,
      accepted: true,
      messageId: 'message-legacy',
    });
    services.subagents.sendMessage = async () => {
      throw Object.assign(new Error('inbox closed'), { code: 'DRAINING' });
    };
    await expectRouteError(
      client.request('subagent.continue', { childId: 'child-1', text: 'later' }),
      'subagent/delivery-unavailable',
      /cannot accept/u,
    );
    services.subagents.sendMessage = originalSendMessage;
    services.subagents.prompt = originalPrompt;

    const interrupted = await client.request('subagent.interrupt', { childId: 'child-1' });
    assert.deepEqual(interrupted, { supported: true, accepted: true });
    assert.deepEqual(calls.filter((call) => call[0] === 'subagents.interruptByParent').at(-1).slice(1), [
      'child-1',
      's1',
      'continuable',
    ]);

    services.subagents.interruptByParent = () => {
      throw Object.assign(new Error('not authorized'), { code: 'UNAUTHORIZED' });
    };
    await expectRouteError(
      client.request('subagent.interrupt', { childId: 'child-1' }),
      'subagent/unauthorized',
      /does not authorize/u,
    );

    services.subagents.interruptByParent = undefined;
    assert.deepEqual(await client.request('subagent.interrupt', { childId: 'child-1' }), {
      supported: true,
      accepted: true,
    });
    services.subagents.interrupt = () => {
      throw Object.assign(new Error('stop failed'), { code: 'CANCELLED' });
    };
    await expectRouteError(client.request('subagent.interrupt', { childId: 'child-1' }), 'gateway/cancelled');
    services.subagents.interrupt = originalInterrupt;
    services.subagents.interruptByParent = originalInterruptByParent;

    state.subagentRows = [];
    await expectRouteError(client.request('subagent.interrupt', { childId: 'missing' }), 'attach/not-found');
    await expectRouteError(
      client.request('subagent.continue', { childId: 'missing', text: 'go' }),
      'attach/not-found',
    );

    state.subagentRows = [
      { kind: 'child', id: 'child-1', parentId: 's1', depth: 1, mode: 'continuable', activity: 'running' },
    ];
    await client.request('session.open', { sessionId: 'child-1', parentSessionId: 's1', mode: 'continuable' });
    assert.deepEqual(
      await client.request('subagent.interrupt', { childId: 'child-1', parentSessionId: 's1' }),
      { supported: true, accepted: true },
    );
    assert.deepEqual(calls.filter((call) => call[0] === 'subagents.interruptByParent').at(-1).slice(1), [
      'child-1',
      's1',
      'continuable',
    ]);

    state.sessionItems = [
      {
        sessionId: 'child-1',
        parentSessionId: 's1',
        origin: 'subagent',
        running: true,
        projections: { values: { title: 'Child' } },
      },
    ];
    await client.request('session.open', { sessionId: 'child-1' });
    assert.deepEqual(await client.request('subagent.interrupt', { childId: 'child-1' }), {
      supported: true,
      accepted: true,
    });
    assert.equal(calls.filter((call) => call[0] === 'session.list').length > 0, true);

    state.sessionItems = [{ sessionId: 's1', running: true }];
    await expectRouteError(
      client.request('subagent.interrupt', { childId: 'child-1' }),
      'attach/bad-request',
      /parentSessionId is required/u,
    );

    let catalogReads = 0;
    services.subagents = {
      get listDescendants() {
        catalogReads += 1;
        return catalogReads === 1 ? async () => [] : undefined;
      },
      prompt: async () => ({ messageId: 'unused' }),
      sendMessage: async () => 'unused',
      interruptByParent: () => ({ accepted: true }),
    };
    catalogReads = 0;
    await expectRouteError(
      client.request('subagent.continue', { childId: 'child-1', text: 'go' }),
      'subagent/control-unavailable',
      /cannot enumerate subagent lineage/u,
    );
    catalogReads = 0;
    await expectRouteError(
      client.request('subagent.interrupt', { childId: 'other-child' }),
      'subagent/control-unavailable',
      /cannot enumerate subagent lineage/u,
    );

    catalogReads = 0;
    services.subagents = {
      get listDescendants() {
        catalogReads += 1;
        if (catalogReads === 1) return async () => [];
        return async () => {
          throw new Error('catalog down');
        };
      },
      prompt: async () => ({ messageId: 'unused' }),
      sendMessage: async () => 'unused',
      interruptByParent: () => ({ accepted: true }),
    };
    await expectRouteError(
      client.request('subagent.continue', { childId: 'child-1', text: 'go' }),
      'subagent/control-unavailable',
      /cannot read the subagent catalog/u,
    );

    services.subagents = { ...runtime, listDescendants: undefined };
    assert.equal((await client.request('subagent.continue', { childId: 'child-1', text: 'go' })).supported, false);
    assert.equal((await client.request('subagent.interrupt', { childId: 'child-1' })).supported, false);
  });
});
