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
  }
  async request(method) {
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
          }],
        };
      case 'commands.list':
        return { commands: [] };
      case 'subagent.list':
        return { supported: false, items: [] };
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

    client.emit('frame', {
      sessionId: 's1',
      frame: {
        type: 'event',
        event: { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' } },
      },
    });
    assert.ok(app.commandGroup, 'shell calls start a command group');
    assert.equal(app.toolRows.get('c1').status, 'running');
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
    assert.equal(app.toolRows.get('c1').status, 'done');
    assert.match(app.commandGroup.render(100).join('\n'), /Ran commands/);
    client.emit('frame', {
      sessionId: 's1',
      frame: {
        type: 'event',
        event: { type: 'tool/call', data: { callId: 'c2', name: 'bash', arguments: '{"command":"npm run build"}' } },
      },
    });
    assert.equal(app.commandGroup.rows.length, 2, 'consecutive shell calls share one group');
    client.emit('frame', {
      sessionId: 's1',
      frame: {
        type: 'event',
        event: { type: 'tool/call', data: { callId: 'c3', name: 'read', arguments: '{"path":"README.md"}' } },
      },
    });
    assert.equal(app.commandGroup, null, 'a non-shell tool closes the command group');

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
