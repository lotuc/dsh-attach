import assert from 'node:assert/strict';
import test from 'node:test';

import { INTERACTION_EVENT_PATH, InteractionEvents } from '../lib/host/interaction-events.js';

function response() {
  return {
    status: null,
    headers: null,
    chunks: [],
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    once() {},
  };
}

test('publishes settlements and replays them to a late companion', () => {
  const events = new InteractionEvents();
  const first = events.publish({
    sessionId: 's1',
    kind: 'approval',
    callId: 'call-1',
    toolName: 'bash',
    outcome: 'allowed-once',
    winner: 'terminal',
  });
  assert.equal(first.id, 1);
  assert.equal(first.outcome, 'allowed-once');

  const late = response();
  events.serve({ method: 'GET' }, late);
  assert.equal(late.status, 200);
  assert.match(late.headers['Content-Type'], /text\/event-stream/);
  assert.match(late.chunks.join(''), /"callId":"call-1"/);
  assert.match(late.chunks.join(''), /"winner":"terminal"/);

  events.publish({
    sessionId: 's1',
    kind: 'approval',
    callId: 'call-2',
    outcome: 'rejected',
    winner: 'web',
  });
  assert.match(late.chunks.join(''), /"callId":"call-2"/);
  assert.equal(INTERACTION_EVENT_PATH, '/dsh-attach/interactions');
  events.close();
  assert.equal(late.writableEnded, true);
});

test('rejects non-GET requests', () => {
  const events = new InteractionEvents();
  const reply = response();
  events.serve({ method: 'POST' }, reply);
  assert.equal(reply.status, 405);
  assert.equal(reply.writableEnded, true);
});

test('drops invalid outcomes but keeps settlement metadata', () => {
  const events = new InteractionEvents();
  const event = events.publish({
    sessionId: 's1',
    kind: 'question',
    outcome: 'unexpected',
    winner: 'timeout',
  });
  assert.equal(event.outcome, null);
  assert.equal(event.kind, 'question');
  assert.equal(event.winner, 'timeout');
});
