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
    this.host = {
      capabilities: ['session.fork', 'session.archive', 'session.pin', 'session.presets'],
      pluginVersion: '2026.1111.1607',
    };
    this.closed = false;
    this.requests = [];
    this.requestCalls = [];
  }
  async request(method, params) {
    this.requests.push(method);
    this.requestCalls.push({ method, params });
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
      case 'btw.ask':
        return { answer: 'side answer', reasoning: 'brief thinking', provider: 'deepseek', model: 'flash' };
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
      case 'session.presets':
        return {
          supported: true,
          defaultId: 'standard',
          presets: [
            { id: 'standard', name: 'Standard mode', description: 'General work', isDefault: true },
            { id: 'minimal', name: 'Minimal mode', description: 'Minimal', isDefault: false },
          ],
        };
      case 'session.create':
        return { sessionId: 's3', agentPreset: params?.agentPreset ?? null };
      case 'session.fork':
        return { sessionId: 'fork-1' };
      case 'session.archive':
        return { archivedSessionIds: [params?.sessionId] };
      case 'session.unarchive':
        return { archivedSessionIds: [] };
      case 'session.pin':
        return { pinnedSessionIds: [params?.sessionId] };
      case 'session.unpin':
        return { pinnedSessionIds: [] };
      default:
        return {};
    }
  }
  async activity() {}
  close() { this.closed = true; }
}

class ControlClient extends FakeClient {
  constructor() {
    super();
    this.host = {
      capabilities: ['subagent.children', 'subagent.continue', 'subagent.interrupt'],
      pluginVersion: '0.15.0',
    };
    this.control = [];
  }
  async request(method, params) {
    if (method === 'subagent.children') {
      return {
        supported: true,
        control: { continue: true, interrupt: true },
        items: [{
          id: 'child-1',
          parentId: 's1',
          depth: 1,
          mode: 'continuable',
          activity: 'running',
          label: 'Reviewer',
          parentActive: true,
          canContinue: true,
          canInterrupt: true,
        }],
      };
    }
    if (method === 'subagent.continue') {
      this.control.push(['continue', params]);
      return { supported: true, accepted: true, messageId: 'message-1' };
    }
    if (method === 'subagent.interrupt') {
      this.control.push(['interrupt', params]);
      return { supported: true, accepted: true };
    }
    return super.request(method, params);
  }
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
  const clipboard = {
    useImage: true,
    image: { mediaType: 'image/png', data: 'YWJj', name: 'clipboard.png' },
    text: 'clipboard text',
  };
  const app = new AttachApp(client, {
    session: 's1',
    logPath: 'off',
    terminal,
    tui,
    readClipboardImage: async () => {
      if (!clipboard.useImage) throw new Error('clipboard does not contain an image');
      return clipboard.image;
    },
    readClipboardText: async () => clipboard.text,
  });
  const running = app.run();
  try {
    for (let attempt = 0; attempt < 100 && app.state.sessionId !== 's1'; attempt += 1) await wait(5);
    assert.equal(app.state.sessionId, 's1');
    assert.ok(app.pendingQueuePanel, 'pending queue panel was built');
    assert.equal(app.queueManagerPanel, null);

    const input = tui.inputListeners[0];
    input('\x16'); // Ctrl+V
    await wait(30);
    assert.equal(app.pendingImages.length, 1, 'Ctrl+V attaches a clipboard image');
    app.pendingImages = [];
    clipboard.useImage = false;
    input('\x16');
    await wait(30);
    assert.match(app.editor.getText(), /clipboard text/, 'Ctrl+V falls back to clipboard text');
    app.editor.setText('');

    client.emit('frame', {
      sessionId: 's1',
      frame: {
        type: 'snapshot',
        header: { cwd: '/tmp/work' },
        projections: {
          values: {
            title: 'Snapshot title',
            goal: { goal: { phase: 'complete', objective: 'done' } },
          },
        },
        records: [{
          type: 'event',
          event: {
            type: 'goal/change',
            data: { goal: { goal: { phase: 'active', objective: 'stale' } } },
          },
        }],
      },
    });
    assert.equal(app.state.goal.phase, 'complete', 'snapshot goal wins over stale history');

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

    // Session-picker lifecycle actions.
    client.requestCalls.length = 0;
    app.editor.setText('/sessions');
    app.editor.handleInput('\r');
    await wait(50);
    app.modals.get('picker').component.panel.handleInput('f');
    await wait(80);
    assert.ok(client.requestCalls.some((call) => call.method === 'session.fork'), 'f forks the selected session');
    assert.equal(app.state.sessionId, 'fork-1');

    client.requestCalls.length = 0;
    app.editor.setText('/sessions');
    app.editor.handleInput('\r');
    await wait(50);
    app.modals.get('picker').component.panel.handleInput('a');
    await wait(80);
    assert.ok(client.requestCalls.some((call) => call.method === 'session.archive'), 'a archives the selected session');

    client.requestCalls.length = 0;
    app.editor.setText('/sessions');
    app.editor.handleInput('\r');
    await wait(50);
    app.modals.get('picker').component.panel.handleInput('p');
    await wait(80);
    assert.ok(client.requestCalls.some((call) => call.method === 'session.pin'), 'p pins the selected session');

    // Preset disclosure and selection for new sessions.
    app.editor.setText('/session presets');
    app.editor.handleInput('\r');
    await wait(50);
    assert.equal(app.modals.has('info'), true, 'the preset roster opens the info panel');
    app.modals.get('info').component.handleInput('\x1b');
    await wait(20);

    app.editor.setText('/session preset minimal');
    app.editor.handleInput('\r');
    await wait(30);
    assert.equal(app.newSessionPreset, 'minimal');

    client.requestCalls.length = 0;
    app.editor.setText('/session new /tmp/work');
    app.editor.handleInput('\r');
    await wait(80);
    const createCall = client.requestCalls.find((call) => call.method === 'session.create');
    assert.equal(createCall?.params?.agentPreset, 'minimal', 'new sessions use the chosen preset');

    app.editor.setText('/sessions');
    app.editor.handleInput('\r');
    await wait(50);
    const restoredPicker = app.modals.get('picker').component.panel;
    const s1Restore = restoredPicker.list.items.find((item) => item.value === 's1');
    restoredPicker.list.onSelect(s1Restore);
    await wait(80);
    assert.equal(app.state.sessionId, 's1', 'the picker reopens the original session');

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
    assert.equal(app.currentTurnFold?.activityLabel, 'Running commands · npm test');
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

    client.emit('frame', {
      sessionId: 's1',
      frame: { type: 'event', event: { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'complete' } } } },
    });
    const fold = [...app.turnFolds.values()].at(-1);
    assert.ok(fold, 'tool work creates one turn-level fold');
    assert.equal(fold.collapsed, true, 'completed work folds by default');
    const folded = app.document.render(100).join('\n');
    assert.match(folded, /Completed at/);
    assert.match(app.activity.render(200).join('\n'), /last completed/);
    assert.doesNotMatch(folded, /npm test/, 'collapsed turn hides command rows');
    fold.setCollapsed(false);
    app.showCommandGroups = true;
    const unfolded = app.document.render(100).join('\n');
    assert.match(unfolded, /npm test/, 'expanded turn shows command rows');

    app.editor.setText('/detail compact');
    app.editor.handleInput('\r');
    await wait(40);
    assert.equal(app.detailLevel, 'compact');
    assert.equal(fold.collapsed, true);
    app.editor.setText('/detail verbose');
    app.editor.handleInput('\r');
    await wait(40);
    assert.equal(app.detailLevel, 'verbose');
    assert.equal(fold.collapsed, false);
    assert.match(app.document.render(100).join('\n'), /npm test/);
    tui.inputListeners[0]('\x07');
    await wait(20);
    assert.equal(app.detailLevel, 'compact', 'Ctrl+G cycles the same detail levels');

    app.editor.setText('/btw where is the retry loop?');
    app.editor.handleInput('\r');
    await wait(80);
    assert.equal(app.modals.has('btw'), true, 'btw opens an overlay');
    const btw = app.modals.get('btw').component;
    assert.match(btw.render(100).join('\n'), /side answer/);
    assert.doesNotMatch(app.document.render(100).join('\n'), /side answer/, 'btw stays outside the transcript');
    btw.handleInput('\x1b');
    await wait(20);
    assert.equal(app.modals.has('btw'), false);
    app.editor.setText('/btw');
    app.editor.handleInput('\r');
    await wait(20);
    assert.equal(app.modals.has('btw'), true, 'bare /btw reopens the latest aside');
    app.modals.get('btw').component.handleInput('\x1b');

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


test('continues and stops a subagent through commands and the picker', async () => {
  const previous = process.env.DSH_ATTACH_NO_MOUSE;
  process.env.DSH_ATTACH_NO_MOUSE = '1';
  const terminal = { columns: 80, rows: 24 };
  const tui = new FakeTui(terminal);
  const client = new ControlClient();
  const app = new AttachApp(client, { session: 's1', logPath: 'off', terminal, tui });
  const running = app.run();
  try {
    for (let attempt = 0; attempt < 100 && app.state.sessionId !== 's1'; attempt += 1) await wait(5);
    assert.equal(app.state.sessionId, 's1');

    app.editor.setText('/subagent continue child-1 hello');
    app.editor.handleInput('\r');
    await wait(80);
    assert.deepEqual(client.control.at(-1), ['continue', { childId: 'child-1', text: 'hello' }]);

    app.editor.setText('/subagent list');
    app.editor.handleInput('\r');
    await wait(80);
    assert.equal(app.modals.has('picker'), true, 'subagent picker opens');
    const picker = app.modals.get('picker').component.panel;
    picker.handleInput('c');
    await wait(40);
    assert.equal(app.modals.has('subagentContinue'), true, 'c opens the follow-up prompt');
    const followUp = app.modals.get('subagentContinue').component;
    followUp.input.setValue('more detail');
    followUp.handleInput('\r');
    await wait(80);
    assert.deepEqual(client.control.at(-1), ['continue', { childId: 'child-1', text: 'more detail' }]);
    assert.equal(app.modals.has('subagentContinue'), false);

    app.editor.setText('/subagent list');
    app.editor.handleInput('\r');
    await wait(80);
    app.modals.get('picker').component.panel.handleInput('x');
    await wait(40);
    assert.equal(app.modals.has('subagentConfirm'), true, 'x asks before stopping');
    assert.equal(client.control.filter((entry) => entry[0] === 'interrupt').length, 0);
    app.modals.get('subagentConfirm').component.handleInput('y');
    await wait(80);
    assert.deepEqual(client.control.at(-1), ['interrupt', { childId: 'child-1', parentSessionId: 's1' }]);
    assert.equal(app.modals.has('subagentConfirm'), false);

    app.editor.setText('/subagent stop child-1');
    app.editor.handleInput('\r');
    await wait(80);
    assert.equal(app.modals.has('subagentConfirm'), true, 'command stop asks first');
    app.modals.get('subagentConfirm').component.handleInput('n');
    await wait(40);
    assert.equal(app.modals.has('subagentConfirm'), false);
    assert.equal(client.control.filter((entry) => entry[0] === 'interrupt').length, 1, 'declining sends nothing');
  } finally {
    app.quit('test');
    await running;
    if (previous === undefined) delete process.env.DSH_ATTACH_NO_MOUSE;
    else process.env.DSH_ATTACH_NO_MOUSE = previous;
  }
  assert.equal(tui.stopped, true);
  assert.equal(client.closed, true);
});


test('retries reconnect after a failed attempt', async () => {
  const previous = process.env.DSH_ATTACH_NO_MOUSE;
  process.env.DSH_ATTACH_NO_MOUSE = '1';
  const terminal = { columns: 80, rows: 24 };
  const tui = new FakeTui(terminal);
  const client = new FakeClient();
  let attempts = 0;
  client.reconnect = async () => {
    attempts += 1;
    throw new Error('host still down');
  };
  const app = new AttachApp(client, { session: 's1', logPath: 'off', terminal, tui });
  const running = app.run();
  try {
    for (let attempt = 0; attempt < 100 && app.state.sessionId !== 's1'; attempt += 1) await wait(5);
    client.emit('close');
    await wait(1_700);
    assert.ok(attempts >= 2, `expected retries after the first failure, saw ${attempts}`);
  } finally {
    app.quit('test');
    await running;
    if (previous === undefined) delete process.env.DSH_ATTACH_NO_MOUSE;
    else process.env.DSH_ATTACH_NO_MOUSE = previous;
  }
});
