/**
 * One-shot, non-interactive execution for scripts and other agents.
 *
 * The runner opens (or creates) one Session, sends one prompt, waits for the
 * Host's terminal `turn/end`, and returns the committed assistant text. It
 * never renders a TUI. Approvals and questions are rejected/cancelled rather
 * than left waiting, so a dispatcher cannot hang on an invisible panel.
 */
import { AttachError } from './connection.js';
import {
  autoApprovalBlocked,
  buildReviewPayload,
  normalizeReviewVerdict,
  parseToolArguments,
} from './auto-approval.js';
import { findExecApprovalRule } from './exec-rules.js';
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

function argumentsOf(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  return parseToolArguments(value);
}

function approvalContext(message, toolCalls, cwd, currentSandbox) {
  const info = typeof message.callId === 'string' ? toolCalls.get(message.callId) : undefined;
  const args = argumentsOf(info?.arguments) ?? {};
  return {
    toolName: typeof message.toolName === 'string' ? message.toolName : (info?.name ?? 'tool'),
    cwd,
    arguments: args,
    reason: typeof message.reason === 'string' ? message.reason : '',
    displayReason: '',
    ...(currentSandbox === null ? {} : { currentSandbox }),
    ...(typeof args.sandbox_permissions === 'string' ? { requestedSandbox: args.sandbox_permissions } : {}),
  };
}

function normalizeInteraction(message) {
  return {
    type: message?.type === 'question' ? 'question' : 'approval',
    requestId: typeof message?.requestId === 'string' ? message.requestId : null,
    tool: typeof message?.toolName === 'string' ? message.toolName : null,
    callId: typeof message?.callId === 'string' ? message.callId : null,
    reason: typeof message?.reason === 'string' ? message.reason : null,
  };
}

/**
 * Run one prompt to completion.
 * @param {import('./connection.js').AttachClient} client
 * @param {{sessionId?: string, prompt: string, cwd?: string, cacheRoot?: string,
 *   timeoutMs?: number, approvals?: 'deny'|'host', approve?: boolean,
 *   approvalRules?: ReturnType<typeof import('./auto-approval.js').normalizeAutoApprovalConfig> | null,
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
  approvalRules = null,
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
    let sessionCwd = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
    let currentSandbox = null;
    let interactiveChain = Promise.resolve();
    let autoApproved = 0;
    const toolCalls = new Map();
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
          const values = frame.projections?.values ?? {};
          if (typeof frame.header?.cwd === 'string') sessionCwd = frame.header.cwd;
          else if (typeof values.workingDirectory === 'string') sessionCwd = values.workingDirectory;
          if (typeof values.permissions?.currentValue === 'string') currentSandbox = values.permissions.currentValue;
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
        case 'tool/call':
          if (typeof data.callId === 'string' && typeof data.name === 'string') {
            toolCalls.set(data.callId, { name: data.name, arguments: data.arguments });
          }
          return;
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

    const fallbackDecision = () => (approvals === 'host'
      ? { outcome: 'delegated', decision: 'delegated to DSH' }
      : { outcome: 'rejected', decision: 'non-interactive exec mode' });

    const decideApproval = async (message) => {
      if (approve) return { outcome: 'allowed-once', decision: 'exec --approve' };
      if (approvalRules === null || approvalRules.enabled !== true) return fallbackDecision();
      const context = approvalContext(message, toolCalls, sessionCwd, currentSandbox);
      if (autoApprovalBlocked(approvalRules, context)) {
        return { outcome: 'rejected', decision: 'approval rules blocked this request' };
      }
      const max = approvalRules.maxAutoApprovals;
      if (max > 0 && autoApproved >= max) {
        return fallbackDecision();
      }
      if (approvalRules.mode === 'review') {
        try {
          const payload = buildReviewPayload(context, null, approvalRules);
          const value = await client.request('approval.review', { payload }, {
            timeoutMs: Math.max(2_000, (approvalRules.timeoutMs ?? 10_000) + 2_000),
          });
          const verdict = normalizeReviewVerdict(value);
          if (verdict.verdict === 'allow') {
            autoApproved += 1;
            return { outcome: 'allowed-once', decision: `rule review${verdict.reason === '' ? '' : `: ${verdict.reason}`}` };
          }
          return fallbackDecision();
        } catch {
          return fallbackDecision();
        }
      }
      const rule = findExecApprovalRule(approvalRules, context);
      if (rule === null) return fallbackDecision();
      autoApproved += 1;
      return { outcome: 'allowed-once', decision: `rule:${rule.id}` };
    };

    const onInteractive = async (message) => {
      if (message?.sessionId !== undefined && message.sessionId !== sessionId) return;
      const record = normalizeInteraction(message);
      if (record.type === 'approval') {
        const decision = await decideApproval(message);
        record.outcome = decision.outcome;
        record.decision = decision.decision;
        interactions.push(record);
        if (decision.outcome === 'delegated') {
          warn(`delegated approval for ${record.tool ?? 'tool'} to DSH`);
          void client.request('interactive.delegate', { requestId: record.requestId }).catch(() => {});
        } else if (decision.outcome === 'allowed-once') {
          warn(`auto-approved ${record.tool ?? 'tool'} · ${decision.decision}`);
          void client.request('approval.respond', {
            requestId: record.requestId,
            outcome: 'allowed-once',
          }).catch(() => {});
        } else {
          warn(`rejected approval for ${record.tool ?? 'tool'} · ${decision.decision}`);
          void client.request('approval.respond', {
            requestId: record.requestId,
            outcome: 'rejected',
          }).catch(() => {});
        }
        return;
      }
      const decision = approvals === 'host'
        ? { outcome: 'delegated', decision: 'delegated to DSH' }
        : { outcome: 'cancelled', decision: 'non-interactive exec mode' };
      record.outcome = decision.outcome;
      record.decision = decision.decision;
      interactions.push(record);
      if (decision.outcome === 'delegated') {
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
    client.on('interactive', (message) => {
      interactiveChain = interactiveChain.then(() => onInteractive(message)).catch(() => {});
    });
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
      await interactiveChain;
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
