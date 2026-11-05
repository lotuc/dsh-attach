import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { AttachApp } from '../lib/client/app.js';
import { normalizeInbox } from '../lib/client/inbox.js';

class FakeTui {
  constructor(terminal) {
    this.terminal = terminal;
    this.overlays = [];
    this.layout = null;
    this.focus = null;
    this.stopped = false;
    this.inputListeners = [];
  }
  start() {}
  stop() { this.stopped = true; }
  requestRender() {}
  setLayoutRoot(layout) { this.layout = layout; }
  setFocus(component) { this.focus = component; }
  addInputListener(listener) { this.inputListeners.push(listener); }
  showOverlay(component, options) {
    const handle = { component, options, hidden: false, hide() { this.hidden = true; } };
    this.overlays.push(handle);
    return handle;
  }
}

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.host = { capabilities: [], pluginVersion: '0.14.0' };
    this.closed = false;
    this.requests = [];
  }
  async request(method) {
    this.requests.push(method);
    switch (method) {
      case 'session.list':
        return {
          items: [{
            sessionId: 's1',
            updatedAt: Date.now(),
            running: false,
            blank: false,
            cwd: '/tmp/work',
            agentAvailable: true,
            projections: { kind: 'sequenced', values: { title: 'Smoke' } },
          }, {
            sessionId: 's2',
            updatedAt: Date.now() - 1_000,
            running: false,
            blank: false,
            cwd: '/tmp/work',
            agentAvailable: true,
            projections: { kind: 'sequenced', values: { title: 'Other' } },
          }],
        };
      case 'commands.list':
        return { commands: [] };
      case 'subagent.list':
        return { supported: false, items: [] };
      case 'job.list':
        return {
          jobs: [{
            id: 'j1',
            kind: 'bash',
            label: 'npm test',
            status: 'running',
            startedAt: Date.now(),
            output: { total: 0, earliest: 0 },
          }],
        };
      default:
        return {};
    }
  }
  async activity() {}
  close() { this.closed = true; }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the app starts, opens a session, and survives slash autocomplete', async () => {
  const previous = process.env.DSH_ATTACH_NO_MOUSE;
  process.env.DSH_ATTACH_NO_MOUSE = '1';
  const terminal = { columns: 80, rows: 24 };
  const tui = new FakeTui(terminal);
  const client = new FakeClient();
  const before = {
    uncaught: process.listenerCount('uncaughtException'),
    rejection: process.listenerCount('unhandledRejection'),
    sigterm: process.listenerCount('SIGTERM'),
    stdinEnd: process.stdin.listenerCount('end'),
  };
  const app = new AttachApp(client, { session: 's1', logPath: 'off', terminal, tui });
  const running = app.run();
  try {
    for (let attempt = 0; attempt < 100 && app.state.sessionId !== 's1'; attempt += 1) await wait(5);
    assert.equal(app.state.sessionId, 's1');
    assert.ok(app.pendingQueuePanel, 'pending queue panel was built');
    assert.equal(app.queueManagerPanel, null);

    client.emit('frame', {
      sessionId: 's1',
      frame: { type: 'event', event: { type: 'session/title', data: { title: 'Smoke session' } } },
    });
    assert.equal(app.state.title, 'Smoke session');
    client.emit('frame', {
      sessionId: 's1',
      frame: {
        type: 'event',
        event: {
          type: 'goal/change',
          data: {
            goal: {
              id: 'g1', revision: 1, phase: 'blocked', objective: 'Finish', maxGoalRounds: 10,
              blockedReason: { code: 'needs-input', message: 'Waiting for input' },
            },
            roundsStarted: 1,
          },
        },
      },
    });
    assert.equal(app.state.goal.phase, 'blocked');
    assert.match(app.activity.render(120).join('\n'), /goal blocked · Waiting for input/);

    let scrollsToEnd = 0;
    const scrollToEnd = app.transcript.scrollToEnd.bind(app.transcript);
    app.transcript.scrollToEnd = () => {
      scrollsToEnd += 1;
      scrollToEnd();
    };
    app.editor.setText('hello after scrolling up');
    app.editor.handleInput('\r');
    await wait(30);
    assert.ok(scrollsToEnd > 0, 'submitting returns the transcript to the live edge');

    app.editor.handleInput('/');
    await wait(50);

    assert.ok(app.pendingQueuePanel, 'slash autocomplete must not clobber the pending queue panel');
    assert.ok(tui.overlays.length > 0, 'slash opens an autocomplete overlay');

    app.inbox = normalizeInbox({
      'next-turn': [{
        id: 'q1',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'later prompt' }],
      }],
    });
    app.editor.cancelAutocomplete();
    app.editor.setText('/queue');
    app.editor.handleInput('\r');
    await wait(50);
    assert.ok(app.queueManagerPanel, 'queue manager opens');
    assert.ok(app.pendingQueuePanel, 'queue manager must not clobber the pending queue panel');
    assert.equal(app.modals.has('queue'), true, 'queue manager owns a modal slot');
    let queuePanel = app.queueManagerPanel;
    queuePanel.handleInput('e');
    await wait(20);
    assert.equal(app.modals.has('queueEdit'), true, 'queue edit opens a text prompt');
    const editPanel = app.modals.get('queueEdit').component;
    editPanel.input.setValue('edited prompt');
    editPanel.handleInput('\r');
    await wait(60);
    assert.ok(client.requests.includes('queue.update'), 'queue edit reaches the bridge');
    assert.equal(app.modals.has('queueEdit'), false);
    queuePanel = app.queueManagerPanel;
    assert.ok(queuePanel, 'queue manager reopens after editing');
    queuePanel.handleInput('\x1b');
    await wait(20);
    assert.equal(app.modals.has('queue'), false, 'escape closes the queue slot');
    assert.equal(app.queueManagerPanel, null);

    app.editor.setText('/jobs');
    app.editor.handleInput('\r');
    await wait(50);
    assert.equal(app.modals.has('jobs'), true, 'jobs panel owns a modal slot');
    assert.ok(app.jobsPanel);
    app.jobsPanel.handleInput('\r');
    await wait(80);
    assert.equal(app.modals.has('jobOutput'), true, 'enter opens job output');
    app.modals.get('jobOutput').component.handleInput('d');
    await wait(20);
    assert.equal(app.modals.has('jobDetails'), true, 'job details open from output');
    app.modals.get('jobDetails').component.handleInput('\x1b');
    await wait(20);
    assert.equal(app.modals.has('jobDetails'), false, 'job details close back to output');
    app.modals.get('jobOutput').component.handleInput('\x1b');
    await wait(20);
    assert.equal(app.modals.has('jobOutput'), false, 'output closes back to jobs');
    app.jobsPanel.handleInput('\x1b');
    await wait(20);
    assert.equal(app.modals.has('jobs'), false, 'escape closes the jobs slot');
    assert.equal(app.jobsPanel, null);

    app.editor.setText('/status');
    app.editor.handleInput('\r');
    await wait(50);
    assert.equal(app.modals.has('info'), true, 'status uses the info modal slot');
    app.modals.get('info').component.handleInput('\x1b');
    await wait(20);
    assert.equal(app.modals.has('info'), false, 'info closes through its panel callback');

    app.editor.setText('/sessions');
    app.editor.handleInput('\r');
    await wait(50);
    assert.equal(app.modals.has('picker'), true, 'session picker uses the shared picker slot');
    app.modals.get('picker').component.handleInput('\x1b');
    await wait(20);
    assert.equal(app.modals.has('picker'), false, 'escape closes the shared picker slot');

    // Drafts and pending images belong to the session that owned them.
    app.editor.setText('/sessions');
    app.editor.handleInput('\r');
    await wait(50);
    const firstPicker = app.modals.get('picker').component.panel;
    app.editor.setText('draft for s1');
    app.pendingImages = [{ name: 's1.png' }];
    const s2Item = firstPicker.list.items.find((item) => item.value === 's2');
    assert.ok(s2Item, 'second session is listed');
    firstPicker.list.onSelect(s2Item);
    await wait(80);
    assert.equal(app.state.sessionId, 's2');
    assert.equal(app.editor.getText(), '', 'another session gets its own empty draft');
    assert.equal(app.pendingImages.length, 0, 'images do not leak across sessions');

    app.editor.setText('/sessions');
    app.editor.handleInput('\r');
    await wait(50);
    const secondPicker = app.modals.get('picker').component.panel;
    app.editor.setText('draft for s2');
    const s1Item = secondPicker.list.items.find((item) => item.value === 's1');
    secondPicker.list.onSelect(s1Item);
    await wait(80);
    assert.equal(app.state.sessionId, 's1');
    assert.equal(app.editor.getText(), 'draft for s1', 'the original draft is restored');
    assert.equal(app.pendingImages[0]?.name, 's1.png', 'the original image is restored');

    client.emit('interactive', {
      type: 'question',
      requestId: 'qq1',
      questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'A' }] }],
    });
    assert.equal(app.modals.has('interactive'), true, 'questions use the interactive modal slot');
    app.modals.get('interactive').component.handleInput('\x1b');
    await wait(40);
    assert.ok(client.requests.includes('interactive.detach'), 'question escape detaches instead of cancelling');
    assert.equal(client.requests.includes('question.cancel'), false);
    assert.equal(app.modals.has('interactive'), false, 'detached question releases the slot');

    client.emit('interactive', { type: 'approval', requestId: 'a1', toolName: 'bash', reason: 'test' });
    assert.equal(app.modals.has('interactive'), true, 'approvals use the interactive modal slot');
    client.emit('interactive-closed', { requestId: 'a1' });
    await wait(40);
    assert.equal(app.modals.has('interactive'), false, 'closing the request releases the slot');

    client.emit('frame', {
      sessionId: 's1',
      frame: {
        type: 'event',
        event: { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' } },
      },
    });
    assert.ok(app.steps.group, 'tool calls start a step group');
    assert.equal(app.steps.rowFor('c1').status, 'running');
    assert.match(app.steps.group.render(100).join('\n'), /Running commands/);
    assert.doesNotMatch(app.steps.group.render(100).join('\n'), /\{"command"/, 'child details stay collapsed under Ctrl+O');
    client.emit('frame', {
      sessionId: 's1',
      frame: {
        type: 'event',
        event: {
          type: 'tool/result',
          data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '2 tests passed' }] } },
        },
      },
    });
    assert.equal(app.steps.rowFor('c1').status, 'done');
    client.emit('frame', {
      sessionId: 's1',
      frame: {
        type: 'event',
        event: { type: 'tool/call', data: { callId: 'c2', name: 'bash', arguments: '{"command":"npm run build"}' } },
      },
    });
    assert.equal(app.steps.group.rows.length, 2, 'consecutive tools share one step group');
    client.emit('frame', {
      sessionId: 's1',
      frame: {
        type: 'event',
        event: { type: 'tool/call', data: { callId: 'c3', name: 'read', arguments: '{"path":"README.md"}' } },
      },
    });
    assert.equal(app.steps.group.rows.length, 3, 'read tools stay in the step group');
    assert.match(app.steps.group.render(100).join('\n'), /Running commands and read files/);
    for (const [callId, text] of [['c2', 'built'], ['c3', 'README.md']]) {
      client.emit('frame', {
        sessionId: 's1',
        frame: {
          type: 'event',
          event: {
            type: 'tool/result',
            data: { message: { toolCallId: callId, content: [{ type: 'text', text }] } },
          },
        },
      });
    }
    client.emit('frame', {
      sessionId: 's1',
      frame: { type: 'event', event: { type: 'step/end', data: {} } },
    });
    assert.match(app.steps.group.render(100).join('\n'), /Ran commands and read files/);
    assert.doesNotMatch(app.steps.group.render(100).join('\n'), /npm test/, 'finished groups collapse automatically');
    app.showCommandGroups = true;
    assert.match(app.steps.group.render(100).join('\n'), /npm test/, 'Ctrl+G expands completed groups');
    app.showCommandGroups = false;

    app.rejectionHandler(new Error('smoke rejection'));
    assert.equal(app.quitting, false, 'a rejected UI callback must not quit the app');
    assert.ok(
      app.rows.some((row) => row.text?.includes('internal error: smoke rejection')),
      'the rejection is reported in the transcript',
    );
  } finally {
    app.quit('test');
    await running;
    if (previous === undefined) delete process.env.DSH_ATTACH_NO_MOUSE;
    else process.env.DSH_ATTACH_NO_MOUSE = previous;
  }
  assert.equal(tui.stopped, true);
  assert.equal(client.closed, true);
  assert.equal(process.listenerCount('uncaughtException'), before.uncaught);
  assert.equal(process.listenerCount('unhandledRejection'), before.rejection);
  assert.equal(process.listenerCount('SIGTERM'), before.sigterm);
  assert.equal(process.stdin.listenerCount('end'), before.stdinEnd);
});
