/**
 * One-shot, non-interactive execution for scripts and other agents.
 *
 * The runner opens (or creates) one Session, sends one prompt, waits for the
 * Host's terminal `turn/end`, and returns the committed assistant text. It
 * never renders a TUI. Approvals and questions are rejected/cancelled rather
 * than left waiting, so a dispatcher cannot hang on an invisible panel.
 */
import { AttachError } from './connection.js';
import { turnFailure } from './turn-failure.js';

export const DEFAULT_EXEC_TIMEOUT_MS = 30 * 60_000;

function textOfMessage(message) {
  const parts = [];
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
  }
  return parts.join('');
}

function normalizeInteraction(message) {
  return {
    type: message?.type === 'question' ? 'question' : 'approval',
    requestId: typeof message?.requestId === 'string' ? message.requestId : null,
    tool: typeof message?.toolName === 'string' ? message.toolName : null,
    reason: typeof message?.reason === 'string' ? message.reason : null,
  };
}

/**
 * Run one prompt to completion.
 * @param {import('./connection.js').AttachClient} client
 * @param {{sessionId?: string, prompt: string, cwd?: string, cacheRoot?: string,
 *   timeoutMs?: number, approvals?: 'deny'|'host', approve?: boolean,
 *   warn?: (message: string) => void}} options
 */
export async function runExec(client, {
  sessionId: requestedSessionId,
  prompt,
  cwd,
  cacheRoot,
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
  approvals = 'deny',
  approve = false,
  warn = () => {},
} = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new AttachError('exec needs a non-empty prompt', 'attach/exec-input');
  }

  let timer = null;
  let settled = false;
  let rejectInterrupt;
  const interruption = new Promise((_, reject) => {
    rejectInterrupt = reject;
  });
  const interrupt = (error) => {
    if (settled) return;
    settled = true;
    void client.request('session.cancel').catch(() => {});
    rejectInterrupt(error);
  };
  const onSigint = () => interrupt(new AttachError('exec interrupted', 'attach/exec-interrupted'));
  process.once('SIGINT', onSigint);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => interrupt(new AttachError(
      `exec timed out after ${Math.round(timeoutMs / 1000)}s`,
      'attach/exec-timeout',
    )), timeoutMs);
  }

  try {
    return await Promise.race([execute(), interruption]);
  } finally {
    settled = true;
    if (timer !== null) clearTimeout(timer);
    process.off('SIGINT', onSigint);
    await client.request('session.close', {}, { timeoutMs: 2_000 }).catch(() => {});
  }

  async function execute() {
    let sessionId = requestedSessionId === undefined ? undefined : String(requestedSessionId);
    if (sessionId === undefined) {
      const created = await client.request('session.create', {
        ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
      });
      sessionId = typeof created?.sessionId === 'string' ? created.sessionId : '';
      if (sessionId === '') throw new AttachError('the Host created no session', 'attach/exec-create');
    } else {
      const listed = await client.request('session.list');
      const found = (Array.isArray(listed?.items) ? listed.items : [])
        .find((item) => String(item.sessionId) === sessionId);
      if (found === undefined) throw new AttachError(`session ${sessionId} was not found`, 'attach/exec-session');
      if (found.running === true) {
        throw new AttachError(
          `session ${sessionId} is already running; use a new session or wait for it to finish`,
          'attach/exec-busy',
        );
      }
    }

    let snapshotSeen = false;
    let awaiting = false;
    let userSeen = false;
    let turnStarted = false;
    let lastText = '';
    let usage = null;
    const interactions = [];
    let snapshotResolve;
    let snapshotReject;
    let turnResolve;
    let turnReject;
    const snapshot = new Promise((resolve, reject) => {
      snapshotResolve = resolve;
      snapshotReject = reject;
    });
    const completion = new Promise((resolve, reject) => {
      turnResolve = resolve;
      turnReject = reject;
    });
    const fail = (error) => {
      if (!snapshotSeen) snapshotReject(error);
      turnReject(error);
    };

    const finishTurn = (data = {}) => {
      const failure = turnFailure(data);
      const reason = typeof data.reason?.kind === 'string' ? data.reason.kind : '';
      turnResolve({
        ok: failure === null && reason !== 'error' && reason !== 'cancelled' && reason !== 'canceled',
        turn: Number(data.turn ?? 0),
        text: lastText,
        reason,
        failure,
        usage,
      });
    };

    // Mark the deferreds handled even when `session.open` throws before either
    // is awaited; a later close event must not become an unhandled rejection.
    snapshot.catch(() => {});
    completion.catch(() => {});

    const onFrame = (message) => {
      if (message?.sessionId !== sessionId) return;
      const frame = message.frame;
      if (frame === null || typeof frame !== 'object') return;
      if (frame.type === 'snapshot') {
        if (!snapshotSeen) {
          snapshotSeen = true;
          snapshotResolve(frame);
        }
        return;
      }
      if (frame.type !== 'event') return;
      const event = frame.event;
      if (event === null || typeof event !== 'object') return;
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return;
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
      switch (event.type) {
        case 'user/message':
          if (awaiting) userSeen = true;
          return;
        case 'turn/start':
          if (awaiting) turnStarted = true;
          return;
        case 'assistant/message': {
          if (!awaiting) return;
          const text = textOfMessage(data.message);
          if (text.trim() !== '') lastText = text;
          if (data.usage !== null && typeof data.usage === 'object') usage = data.usage;
          return;
        }
        case 'turn/end':
          if (awaiting && (userSeen || turnStarted)) finishTurn(data);
          return;
        default:
          return;
      }
    };

    const onInteractive = (message) => {
      if (message?.sessionId !== undefined && message.sessionId !== sessionId) return;
      const record = normalizeInteraction(message);
      const policy = approve ? 'allow' : approvals;
      if (record.type === 'approval') {
        record.outcome = policy === 'allow'
          ? 'allowed-once'
          : policy === 'host' ? 'delegated' : 'rejected';
        record.reason ??= policy === 'allow'
          ? 'exec --approve'
          : policy === 'host' ? 'delegated to DSH' : 'non-interactive exec mode';
        interactions.push(record);
        if (policy === 'host') {
          warn(`delegated approval for ${record.tool ?? 'tool'} to DSH`);
          void client.request('interactive.delegate', { requestId: record.requestId }).catch(() => {});
        } else {
          warn(`${policy === 'allow' ? 'approved' : 'rejected'} approval for ${record.tool ?? 'tool'}${policy === 'allow' ? '' : '; exec mode is non-interactive'}`);
          void client.request('approval.respond', {
            requestId: record.requestId,
            outcome: policy === 'allow' ? 'allowed-once' : 'rejected',
          }).catch(() => {});
        }
        return;
      }
      record.outcome = policy === 'host' ? 'delegated' : 'cancelled';
      record.reason ??= policy === 'host' ? 'delegated to DSH' : 'non-interactive exec mode';
      interactions.push(record);
      if (policy === 'host') {
        warn('delegated question to DSH');
        void client.request('interactive.delegate', { requestId: record.requestId }).catch(() => {});
      } else {
        warn('cancelled a question; exec mode is non-interactive');
        void client.request('question.cancel', { requestId: record.requestId }).catch(() => {});
      }
    };

    const onSessionError = (message) => {
      if (message?.sessionId !== undefined && message.sessionId !== sessionId) return;
      const error = new AttachError(
        message?.error?.message ?? 'exec session failed',
        message?.error?.code ?? 'attach/exec-session',
      );
      fail(error);
    };
    const onClose = () => fail(new AttachError('Host connection closed during exec', 'attach/closed'));
    const onProtocolError = (error) => fail(error instanceof Error ? error : new AttachError(String(error)));

    client.on('frame', onFrame);
    client.on('interactive', onInteractive);
    client.on('session-error', onSessionError);
    client.on('close', onClose);
    client.on('protocol-error', onProtocolError);
    try {
      await client.request('session.open', {
        sessionId,
        ...(typeof cacheRoot === 'string' && cacheRoot !== '' ? { cacheRoot } : {}),
      });
      await snapshot;
      awaiting = true;
      try {
        await client.request('session.prompt', { text: prompt, mode: 'queue' });
      } catch (error) {
        awaiting = false;
        throw error;
      }
      const result = await completion;
      return { ...result, sessionId, interactions };
    } finally {
      client.off('frame', onFrame);
      client.off('interactive', onInteractive);
      client.off('session-error', onSessionError);
      client.off('close', onClose);
      client.off('protocol-error', onProtocolError);
    }
  }
}
