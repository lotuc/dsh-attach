import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { expectRouteError, startAttachHost, withAttachHost } from './helpers/attach-host.mjs';

const delay = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function approvalRequest(sessionId = 's1', overrides = {}) {
  return {
    agent: { session: { id: sessionId } },
    toolName: 'bash',
    reason: 'install a dependency',
    displayReason: { en: 'Install a dependency', zh: '安装依赖' },
    callId: 'call-1',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function questionRequest(sessionId = 's1', overrides = {}) {
  return {
    agent: { session: { id: sessionId } },
    questions: [{ id: 'q1', question: 'Continue?', options: [{ label: 'yes' }, { label: 'no' }] }],
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('approvals and questions are acked, detached, answered and cancelled', async () => {
  await withAttachHost(async ({ client, listeners, server, state }) => {
    await client.request('session.open', { sessionId: 's1' });
    await delay();

    assert.deepEqual(await client.request('interactive.ack', { requestId: 'missing' }), { accepted: false });
    await expectRouteError(client.request('interactive.detach', { requestId: 'missing' }), 'attach/not-open');
    await expectRouteError(
      client.request('approval.respond', { requestId: 'missing', outcome: 'allowed-once' }),
      'attach/not-open',
    );
    await expectRouteError(client.request('approval.cancel', { requestId: 'missing' }), 'attach/not-open');
    await expectRouteError(
      client.request('question.respond', { requestId: 'missing', answers: [] }),
      'attach/not-open',
    );
    await expectRouteError(client.request('question.cancel', { requestId: 'missing' }), 'attach/not-open');

    const approvalSeen = once(client, 'interactive');
    let delegated = 0;
    const approval = listeners.get('approval/request')(approvalRequest(), () => {
      delegated += 1;
      return 'delegated';
    });
    const [approvalMessage] = await approvalSeen;
    assert.equal(approvalMessage.type, 'approval');
    assert.equal(approvalMessage.sessionId, 's1');
    assert.equal(approvalMessage.toolName, 'bash');
    assert.equal(approvalMessage.reason, 'install a dependency');
    assert.equal(approvalMessage.displayReason, '安装依赖');
    assert.equal(approvalMessage.callId, 'call-1');
    assert.deepEqual(await client.request('interactive.ack', { requestId: approvalMessage.requestId }), {
      accepted: true,
    });
    assert.deepEqual(await client.request('interactive.detach', { requestId: approvalMessage.requestId }), {
      accepted: true,
    });
    assert.deepEqual(await client.request('approval.cancel', { requestId: approvalMessage.requestId }), {
      accepted: true,
    });
    assert.equal(await approval, 'delegated');
    assert.equal(delegated, 1);

    const secondSeen = once(client, 'interactive');
    const second = listeners.get('approval/request')(approvalRequest(), () => 'unavailable');
    const [secondMessage] = await secondSeen;
    await expectRouteError(
      client.request('approval.respond', { requestId: secondMessage.requestId, outcome: 'maybe' }),
      'attach/bad-request',
      /allowed-once or rejected/u,
    );
    await client.request('approval.cancel', { requestId: secondMessage.requestId });
    assert.equal(await second, 'unavailable');

    const questionSeen = once(client, 'interactive');
    const question = listeners.get('user-questions/request')(questionRequest(), () => 'delegated-question');
    const [questionMessage] = await questionSeen;
    assert.equal(questionMessage.type, 'question');
    assert.deepEqual(questionMessage.questions, questionRequest().questions);
    assert.equal(questionMessage.wait, null);
    await expectRouteError(
      client.request('question.respond', { requestId: questionMessage.requestId, answers: 'nope' }),
      'attach/bad-request',
      /answers must be an array/u,
    );
    assert.deepEqual(
      await client.request('question.respond', {
        requestId: questionMessage.requestId,
        answers: [{ id: 'q1', selected: ['yes'] }],
      }),
      { accepted: true },
    );
    assert.deepEqual(await question, { answers: [{ id: 'q1', selected: ['yes'] }] });

    const cancelledSeen = once(client, 'interactive');
    const cancelledQuestion = listeners.get('user-questions/request')(questionRequest(), () => 'cancelled-question');
    const [cancelledMessage] = await cancelledSeen;
    assert.deepEqual(await client.request('question.cancel', { requestId: cancelledMessage.requestId }), {
      accepted: true,
    });
    assert.equal(await cancelledQuestion, 'cancelled-question');

    let delegatedNoAgent = 0;
    assert.equal(
      await listeners.get('approval/request')({ toolName: 'bash' }, () => {
        delegatedNoAgent += 1;
        return 'no-agent';
      }),
      'no-agent',
    );
    assert.equal(delegatedNoAgent, 1);

    server.config.approvals = 'off';
    server.config.questions = 'off';
    assert.equal(
      await listeners.get('approval/request')(approvalRequest(), () => 'approval-off'),
      'approval-off',
    );
    assert.equal(
      await listeners.get('user-questions/request')(questionRequest(), () => 'question-off'),
      'question-off',
    );
    server.config.approvals = 'auto';
    server.config.questions = 'auto';

    let aborted = 0;
    const abortedController = new AbortController();
    abortedController.abort();
    assert.equal(
      await listeners.get('approval/request')(approvalRequest('s1', { signal: abortedController.signal }), () => {
        aborted += 1;
        return 'aborted';
      }),
      'aborted',
    );
    assert.equal(aborted, 1);

    const switchSeen = once(client, 'interactive');
    const switchClosed = once(client, 'interactive-closed');
    const switched = listeners.get('user-questions/request')(questionRequest(), () => 'after-switch');
    const [switchMessage] = await switchSeen;
    await client.request('session.open', { sessionId: 's2' });
    const [closed] = await switchClosed;
    assert.equal(closed.requestId, switchMessage.requestId);
    assert.equal(closed.type, 'question.closed');
    await client.request('question.cancel', { requestId: switchMessage.requestId });
    assert.equal(await switched, 'after-switch');
    await client.request('session.open', { sessionId: 's1' });

    const timedSeen = once(client, 'interactive');
    const timed = listeners.get('user-questions/request')(
      questionRequest('s1', { wait: { timed: true, callId: 'wait-1' } }),
      () => 'timed',
    );
    const [timedMessage] = await timedSeen;
    await delay(5);
    assert.equal(state.attachWait.callId, 'wait-1');
    await client.request('question.cancel', { requestId: timedMessage.requestId });
    assert.equal(await timed, 'timed');
    await delay(5);
    assert.equal(state.attachWait.signal.aborted, true);

    const closeSeen = once(client, 'interactive');
    const afterClose = listeners.get('approval/request')(approvalRequest(), () => 'after-close');
    await closeSeen;
    client.close();
    assert.equal(await afterClose, 'after-close');

  });
});

test('a pending approval goes to the Web answerer when no terminal is attached', async () => {
  const host = await startAttachHost();
  try {
    host.state.webLive = true;
    const allowed = await host.listeners.get('approval/request')(approvalRequest(), () => 'allowed-once');
    assert.equal(allowed, 'allowed-once');

    const delegated = await host.listeners.get('approval/request')(approvalRequest(), () => undefined);
    assert.equal(delegated, undefined);

    const failed = await host.listeners.get('approval/request')(approvalRequest(), () => {
      throw new Error('web answerer failed');
    });
    assert.equal(failed, undefined);
  } finally {
    await host.cleanup();
  }
});

test('auto routing leaves an unclaimed interaction to the Web answerer', async () => {
  await withAttachHost(async ({ client, listeners, server, services }) => {
    await client.request('session.open', { sessionId: 's1' });
    await delay();
    server.config.activeWindowMinutes = 0;
    services.typertGateway = {
      hasLiveClient() {
        throw new Error('gateway unavailable');
      },
    };
    let delegated = 0;
    const pending = listeners.get('approval/request')(approvalRequest(), () => {
      delegated += 1;
      return 'not-routed';
    });
    await delay(20);
    assert.equal(delegated, 0);
    const [requestId] = [...server.pending.keys()];
    assert.equal(typeof requestId, 'string');
    await client.request('approval.cancel', { requestId });
    assert.equal(await pending, 'not-routed');
    assert.equal(delegated, 1);
  });
});

test('grace releases an unacknowledged terminal approval when no Web client is live', async () => {
  await withAttachHost(
    async ({ client, listeners }) => {
      await client.request('session.open', { sessionId: 's1' });
      await delay();
      const seen = once(client, 'interactive');
      let delegated = 0;
      const pending = listeners.get('approval/request')(approvalRequest(), () => {
        delegated += 1;
        return 'after-grace';
      });
      await seen;
      await delay(40);
      assert.equal(await pending, 'after-grace');
      assert.equal(delegated, 1);
    },
    { config: { approvals: 'tui', approvalGraceSeconds: 0.01 } },
  );
});
