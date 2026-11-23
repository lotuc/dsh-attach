/**
 * Broadcast interaction settlements to the Web client companion.
 *
 * The TUI and the native Web approval UI answer through separate paths. This
 * bus is the one-way signal that lets the Web companion close its pending
 * approval after the TUI won, without giving the Web client another decision.
 */
export const INTERACTION_EVENT_PATH = '/dsh-attach/interactions';

const RECENT_LIMIT = 128;
const HEARTBEAT_MS = 15_000;

function frame(event) {
  return `id: ${event.id}\nevent: interaction\ndata: ${JSON.stringify(event)}\n\n`;
}

/** One bounded replay log plus the currently connected SSE responses. */
export class InteractionEvents {
  #nextId = 1;
  #recent = [];
  #clients = new Set();

  /**
   * Record one settlement and publish it to every connected companion.
   * @param {{sessionId: string, kind: string, callId?: string|null, toolName?: string|null,
   *   outcome?: string|null, winner?: string|null, reason?: string|null}} input
   */
  publish(input) {
    const event = {
      id: this.#nextId++,
      at: Date.now(),
      sessionId: String(input.sessionId),
      kind: String(input.kind),
      callId: typeof input.callId === 'string' ? input.callId : null,
      toolName: typeof input.toolName === 'string' ? input.toolName : null,
      outcome: input.outcome === 'allowed-once' || input.outcome === 'rejected' ? input.outcome : null,
      winner: typeof input.winner === 'string' ? input.winner : null,
      reason: typeof input.reason === 'string' ? input.reason : null,
    };
    this.#recent.push(event);
    if (this.#recent.length > RECENT_LIMIT) this.#recent.shift();
    for (const client of this.#clients) this.#write(client, event);
    return event;
  }

  /**
   * Serve one SSE response. Replays the recent log so a companion that opened
   * just after a settlement still closes the right panel.
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  serve(request, response) {
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' });
      response.end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    response.write(': connected\n\n');
    for (const event of this.#recent) this.#write(response, event);
    this.#clients.add(response);
    const heartbeat = setInterval(() => {
      if (response.writableEnded) return;
      try {
        response.write(': ping\n\n');
      } catch {
        // The close handler removes the response.
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    const close = () => {
      clearInterval(heartbeat);
      this.#clients.delete(response);
    };
    response.once('close', close);
    response.once('error', close);
  }

  /** Close every companion stream. */
  close() {
    for (const response of this.#clients) {
      try {
        response.end();
      } catch {
        // The response may already be gone.
      }
    }
    this.#clients.clear();
  }

  #write(response, event) {
    if (response.writableEnded === true || response.destroyed === true) {
      this.#clients.delete(response);
      return;
    }
    try {
      response.write(frame(event));
    } catch {
      this.#clients.delete(response);
    }
  }
}
