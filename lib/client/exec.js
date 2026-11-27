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
import { isPermissionPreset, parseModelSelection, permissionPresetValues } from './exec-options.js';
import { findExecApprovalRule } from './exec-rules.js';
import { isFatalSshCode, isRetryableAttachCode } from './ssh-transport.js';
import { approvalReasonText } from '../shared/approval.js';
import { turnFailure } from './turn-failure.js';

export const DEFAULT_EXEC_TIMEOUT_MS = 30 * 60_000;
/** How long a remote turn may be reconnected before exec gives up. */
export const DEFAULT_RECONNECT_WINDOW_MS = 60_000;
/** Maximum characters of tool arguments/output carried by one streaming event. */
export const EXEC_TOOL_EVENT_LIMIT = 16_384;
const SNAPSHOT_REOPEN_TIMEOUT_MS = 10_000;

/** Best-effort observer callback: output must never break the exec run. */
function notify(callback, ...args) {
  if (typeof callback !== 'function') return;
  try {
    callback(...args);
  } catch {
    // A progress observer is advisory; the session keeps running.
  }
}

/** `true`/`false` when the Host advertises capabilities, otherwise unknown. */
function hostSupports(client, feature) {
  const capabilities = client?.host?.capabilities;
  return Array.isArray(capabilities) ? capabilities.includes(feature) : null;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  const parts = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
  }
  return parts.join('');
}

function textOfMessage(message) {
  if (typeof message === 'string') return message;
  return textOfContent(message?.content);
}

/** Stringify one streamed value and bound it to `limit` characters. */
function boundedEventText(value, limit = EXEC_TOOL_EVENT_LIMIT) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else if (value === undefined || value === null) {
    text = '';
  } else {
    try {
      const encoded = JSON.stringify(value);
      text = typeof encoded === 'string' ? encoded : String(value);
    } catch {
      text = String(value);
    }
  }
  if (typeof text !== 'string') text = String(text);
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

function errorTextOf(error) {
  if (typeof error === 'string') return error;
  if (error === null || typeof error !== 'object') return '';
  if (typeof error.message === 'string') return error.message;
  if (typeof error.error === 'string') return error.error;
  return '';
}

/**
 * Extract the human-readable output of one `tool/result` event and decide
 * whether the call failed. The Host stores the tool message under `message`;
 * errors may live on either the event wrapper or the message.
 */
function toolResultOf(data, toolCalls) {
  const rawMessage = data?.message;
  const message = rawMessage !== null && typeof rawMessage === 'object' ? rawMessage : {};
  const callId = typeof message.toolCallId === 'string'
    ? message.toolCallId
    : (typeof data?.callId === 'string' ? data.callId : null);
  const info = callId === null ? undefined : toolCalls.get(callId);
  const name = info?.name
    ?? (typeof data?.name === 'string' ? data.name : null)
    ?? (typeof message.name === 'string' ? message.name : null);
  const isError = data?.error !== undefined || message.isError === true;
  let output = textOfContent(message.content);
  if (output === '' && typeof rawMessage === 'string') output = rawMessage;
  if (output === '' && typeof message.text === 'string') output = message.text;
  if (output === '' && data?.content !== undefined) output = textOfContent(data.content);
  if (output === '' && typeof data?.text === 'string') output = data.text;
  if (output === '' && typeof data?.output === 'string') output = data.output;
  if (output === '') output = errorTextOf(data?.error) || errorTextOf(message.error);
  const bounded = boundedEventText(output);
  return {
    callId,
    name,
    ok: !isError,
    output: bounded.text,
    ...(bounded.truncated ? { truncated: true } : {}),
  };
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
    displayReason: approvalReasonText(message.displayReason),
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
 *   allowDirs?: string[], permission?: string, model?: string, preset?: string, title?: string,
 *   ssh?: string, sshOpts?: string[], remoteBin?: string, profile?: string,
 *   reconnect?: (() => Promise<unknown>)|null, reconnectWindowMs?: number,
 *   onSession?: (sessionId: string, facts: {cwd: string}) => void,
 *   onTextDelta?: (delta: {sessionId: string, text: string}) => void,
 *   onReasoningDelta?: (delta: {sessionId: string, text: string}) => void,
 *   onToolCall?: (call: {sessionId: string, callId: string, name: string,
 *     arguments: string, truncated?: true}) => void,
 *   onToolResult?: (result: {sessionId: string, callId: string|null, name: string|null,
 *     ok: boolean, output: string, truncated?: true}) => void,
 *   onInteraction?: (record: {sessionId: string, type: 'approval'|'question',
 *     requestId: string|null, tool: string|null, callId: string|null,
 *     reason: string|null, outcome: string, decision: string}) => void,
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
  allowDirs = [],
  permission,
  model,
  preset,
  title,
  ssh,
  sshOpts = [],
  remoteBin,
  profile,
  reconnect,
  reconnectWindowMs = DEFAULT_RECONNECT_WINDOW_MS,
  onSession,
  onTextDelta,
  onReasoningDelta,
  onToolCall,
  onToolResult,
  onInteraction,
  warn = () => {},
} = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new AttachError('exec needs a non-empty prompt', 'attach/exec-input');
  }
  if (!Array.isArray(allowDirs)) {
    throw new AttachError('exec allowDirs must be an array of directories', 'attach/exec-input');
  }
  if (requestedSessionId !== undefined && String(requestedSessionId).trim() === '') {
    throw new AttachError('--session needs a session id', 'attach/exec-input');
  }
  const writableRoots = [...new Set(allowDirs
    .map((directory) => (typeof directory === 'string' ? directory.trim() : ''))
    .filter((directory) => directory !== ''))];
  if (permission !== undefined && !isPermissionPreset(permission)) {
    throw new AttachError(
      `--permission must be one of ${permissionPresetValues().join(', ')}`,
      'attach/exec-permission',
    );
  }
  const modelSelection = model === undefined ? null : parseModelSelection(model);
  if (model !== undefined && modelSelection === null) {
    throw new AttachError('--model must use the provider/model form', 'attach/exec-model');
  }
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
    throw new AttachError('--title needs a non-empty title', 'attach/exec-title');
  }
  if (preset !== undefined) {
    if (typeof preset !== 'string' || preset.trim() === '') {
      throw new AttachError('--preset needs a non-empty agent preset id', 'attach/exec-preset');
    }
    if (requestedSessionId !== undefined) {
      throw new AttachError('--preset only applies to a new session', 'attach/exec-preset');
    }
  }
  const requestedPreset = preset === undefined ? null : preset.trim();
  const requestedTitle = title === undefined ? null : title.trim();

  // Remote exec may recover a dropped SSH hop while its turn keeps running.
  // Local `/tmp` sockets are not expected to need this, so only SSH gets it.
  const remoteTarget = typeof ssh === 'string' && ssh !== '' ? ssh : null;
  const reconnectFn = typeof reconnect === 'function'
    ? reconnect
    : remoteTarget === null
      ? null
      : () => client.reconnect({
        ssh: remoteTarget,
        sshOpts,
        remoteBin,
        profile,
        batchMode: true,
        timeoutMs: 15_000,
      });
  const reconnectBudgetMs = Number.isFinite(reconnectWindowMs) && reconnectWindowMs > 0
    ? reconnectWindowMs
    : DEFAULT_RECONNECT_WINDOW_MS;

  let activeSessionId = requestedSessionId === undefined ? undefined : String(requestedSessionId);
  let timer = null;
  let settled = false;
  let wakeSettled;
  /** Wakes a recovery backoff immediately on timeout, SIGINT, or completion. */
  const settledSignal = new Promise((resolve) => {
    wakeSettled = resolve;
  });
  let rejectInterrupt;
  const interruption = new Promise((_, reject) => {
    rejectInterrupt = reject;
  });
  const interrupt = (error) => {
    if (settled) return;
    settled = true;
    if (error !== null && typeof error === 'object' && activeSessionId !== undefined
      && error.sessionId === undefined) {
      error.sessionId = activeSessionId;
    }
    void client.request('session.cancel').catch(() => {});
    rejectInterrupt(error);
  };
  const onSigint = () => interrupt(new AttachError('exec interrupted', 'attach/exec-interrupted'));
  const onSigterm = () => {
    const error = new AttachError('exec terminated', 'attach/exec-interrupted');
    error.signal = 'SIGTERM';
    interrupt(error);
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => interrupt(new AttachError(
      `exec timed out after ${Math.round(timeoutMs / 1000)}s`,
      'attach/exec-timeout',
    )), timeoutMs);
  }

  try {
    return await Promise.race([execute(), interruption]);
  } catch (error) {
    // Timeout/interrupt/close errors win the race outside `execute`; attach the
    // session the caller can resume with so `-s <id>` stays usable.
    if (activeSessionId !== undefined && error !== null && typeof error === 'object'
      && error.sessionId === undefined) {
      error.sessionId = activeSessionId;
    }
    throw error;
  } finally {
    settled = true;
    wakeSettled?.();
    if (timer !== null) clearTimeout(timer);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    await client.request('session.close', {}, { timeoutMs: 2_000 }).catch(() => {});
  }

  async function execute() {
    let sessionId = requestedSessionId === undefined ? undefined : String(requestedSessionId);
    if (sessionId === undefined) {
      const created = await client.request('session.create', {
        ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
        ...(requestedPreset === null ? {} : { agentPreset: requestedPreset }),
      });
      sessionId = typeof created?.sessionId === 'string' ? created.sessionId : '';
      if (sessionId === '') throw new AttachError('the Host created no session', 'attach/exec-create');
      activeSessionId = sessionId;
    } else {
      activeSessionId = sessionId;
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

    let snapshotWaiter = null;
    let awaiting = false;
    let userSeen = false;
    let turnStarted = false;
    let recovering = false;
    /** Counts live event frames so a snapshot cannot overwrite newer text. */
    let liveEventGeneration = 0;
    /**
     * Sequence boundary from the initial snapshot. A post-reconnect snapshot
     * must not mistake an older turn (already in history) for this exec turn.
     */
    let historyBaselineSeq = null;
    let historyBaselineCaptured = false;
    let lastText = '';
    let usage = null;
    let sessionCwd = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
    let currentSandbox = null;
    let interactiveChain = Promise.resolve();
    let autoApproved = 0;
    const toolCalls = new Map();
    const interactions = [];
    let turnResolve;
    let turnReject;
    const completion = new Promise((resolve, reject) => {
      turnResolve = resolve;
      turnReject = reject;
    });
    /** Wait for the next snapshot, including the one a reconnect triggers. */
    const nextSnapshot = () => {
      const deferred = Promise.withResolvers();
      // A close can reject this before the caller reaches `await`; keep that
      // from surfacing as an unhandled rejection during abort.
      deferred.promise.catch(() => {});
      snapshotWaiter = deferred;
      return deferred.promise;
    };
    const fail = (error) => {
      const waiter = snapshotWaiter;
      snapshotWaiter = null;
      waiter?.reject(error);
      turnReject(error);
    };

    const finishTurn = (data = {}) => {
      // Stop forwarding live deltas/tool results once the turn is terminal.
      awaiting = false;
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

    // Mark the deferred handled even when `session.open` throws before it is
    // awaited; a later close event must not become an unhandled rejection.
    completion.catch(() => {});

    const onFrame = (message) => {
      if (message?.sessionId !== sessionId) return;
      const frame = message.frame;
      if (frame === null || typeof frame !== 'object') return;
      if (frame.type === 'snapshot') {
        const values = frame.projections?.values ?? {};
        if (typeof frame.header?.cwd === 'string') sessionCwd = frame.header.cwd;
        else if (typeof values.workingDirectory === 'string') sessionCwd = values.workingDirectory;
        if (typeof values.permissions?.currentValue === 'string') currentSandbox = values.permissions.currentValue;
        if (!historyBaselineCaptured) {
          historyBaselineCaptured = true;
          if (Number.isFinite(Number(frame.cursor))) {
            historyBaselineSeq = Number(frame.cursor);
          } else {
            let max = null;
            for (const record of Array.isArray(frame.records) ? frame.records : []) {
              const seq = Number(record?.seq);
              if (Number.isFinite(seq)) max = max === null ? seq : Math.max(max, seq);
            }
            historyBaselineSeq = max;
          }
        }
        const waiter = snapshotWaiter;
        snapshotWaiter = null;
        waiter?.resolve(frame);
        return;
      }
      if (frame.type === 'assistant-stream' || frame.type === 'assistant_stream') {
        if (!awaiting) return;
        const inner = frame.frame;
        if (inner?.type !== 'chunk') return;
        const chunk = inner.chunk;
        if (chunk === null || typeof chunk !== 'object') return;
        const text = typeof chunk.text === 'string' ? chunk.text : '';
        if (text === '') return;
        if (chunk.type === 'text-delta') notify(onTextDelta, { sessionId, text });
        else if (chunk.type === 'reasoning-delta') notify(onReasoningDelta, { sessionId, text });
        return;
      }
      if (frame.type !== 'event') return;
      liveEventGeneration += 1;
      const event = frame.event;
      if (event === null || typeof event !== 'object') return;
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return;
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
      switch (event.type) {
        case 'tool/call':
          if (typeof data.callId === 'string' && typeof data.name === 'string') {
            toolCalls.set(data.callId, { name: data.name, arguments: data.arguments });
            const args = boundedEventText(data.arguments);
            notify(onToolCall, {
              sessionId,
              callId: data.callId,
              name: data.name,
              arguments: args.text,
              ...(args.truncated ? { truncated: true } : {}),
            });
          }
          return;
        case 'tool/result':
          if (awaiting) {
            notify(onToolResult, { sessionId, ...toolResultOf(data, toolCalls) });
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
        notify(onInteraction, { sessionId, ...record });
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
      notify(onInteraction, { sessionId, ...record });
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
    const onClose = (error) => {
      if (recovering) return;
      if (reconnectFn === null || !awaiting || activeSessionId === undefined) {
        fail(new AttachError('Host connection closed during exec', 'attach/closed'));
        return;
      }
      recovering = true;
      void recover(error);
    };
    const onProtocolError = (error) => fail(error instanceof Error ? error : new AttachError(String(error)));

    /** Register explicit writable roots; an unregistered root is a hard failure. */
    const applyWritableRoots = async () => {
      if (hostSupports(client, 'sandbox.roots') === false) {
        throw new AttachError(
          'this Host does not support --allow-dir (sandbox.roots is unavailable)',
          'attach/exec-allow-dir',
        );
      }
      for (const directory of writableRoots) {
        let value;
        try {
          value = await client.request('sandbox.allowDir', { directory });
        } catch (error) {
          throw new AttachError(
            `cannot allow directory ${directory}: ${messageOf(error)}`,
            'attach/exec-allow-dir',
          );
        }
        if (value?.supported === false) {
          throw new AttachError(
            `this Host does not support --allow-dir (sandbox.roots is unavailable): ${directory}`,
            'attach/exec-allow-dir',
          );
        }
        if (typeof value?.error === 'string' && value.error !== '') {
          throw new AttachError(
            `the Host rejected writable root ${directory} (${value.error})`,
            'attach/exec-allow-dir',
          );
        }
        const resolvedDir = typeof value?.directory === 'string' && value.directory !== '' ? value.directory : directory;
        const pending = Array.isArray(value?.pending) && value.pending.includes(resolvedDir);
        if (value?.registered !== true && !pending) {
          throw new AttachError(
            `the Host did not register writable root ${directory}`,
            'attach/exec-allow-dir',
          );
        }
      }
    };

    /** Apply `/permission <value>` before the prompt; unsupported Hosts fail. */
    const applyPermission = async () => {
      if (hostSupports(client, 'commands') === false) {
        throw new AttachError(
          'this Host does not support --permission (commands are unavailable)',
          'attach/exec-permission',
        );
      }
      try {
        const value = await client.request('commands.execute', { line: `/permission ${permission}` });
        if (value?.executed !== true) throw new Error('the Host did not run the command');
      } catch (error) {
        throw new AttachError(
          `cannot apply --permission ${permission}: ${messageOf(error)}`,
          'attach/exec-permission',
        );
      }
    };

    const applyModel = async () => {
      try {
        await client.request('session.selectModel', modelSelection);
      } catch (error) {
        throw new AttachError(
          `cannot select --model ${modelSelection.provider}/${modelSelection.model}: ${messageOf(error)}`,
          'attach/exec-model',
        );
      }
    };

    const applyTitle = async () => {
      try {
        await client.request('session.rename', { sessionId, title: requestedTitle });
      } catch (error) {
        throw new AttachError(`cannot set --title: ${messageOf(error)}`, 'attach/exec-title');
      }
    };

    const applyHostOptions = async () => {
      if (writableRoots.length > 0) await applyWritableRoots();
      if (permission !== undefined) await applyPermission();
      if (modelSelection !== null) await applyModel();
      if (requestedTitle !== null) await applyTitle();
    };

    const sleep = (ms) => new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

    /** Bound one post-reconnect wait so a silent proxy cannot stall exec. */
    const awaitWithTimeout = (promise, ms, message) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AttachError(message, 'attach/timeout')), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });

    /**
     * Inspect a fresh snapshot to decide whether the in-flight turn finished
     * while the connection was down. Only records after the last user message
     * belong to this exec turn.
     */
    const analyzeSnapshot = (frame) => {
      const allRecords = Array.isArray(frame?.records) ? frame.records : [];
      // Only records newer than the pre-prompt snapshot belong to this turn;
      // otherwise an old turn/end in history would look like our completion.
      const records = historyBaselineSeq === null
        ? allRecords
        : allRecords.filter((record) => {
          const seq = Number(record?.seq);
          return !Number.isFinite(seq) || seq > historyBaselineSeq;
        });
      let lastUserIndex = -1;
      const sawUser = records.some((record) => (
        record?.type === 'event' && record.event?.type === 'user/message'
      ));
      for (let index = 0; index < records.length; index += 1) {
        const event = records[index]?.type === 'event' ? records[index].event : null;
        if (event?.type === 'user/message') lastUserIndex = index;
      }
      let text = null;
      let usageValue = null;
      let end = null;
      let sawTurnStart = false;
      const calls = new Map();
      for (let index = lastUserIndex + 1; index < records.length; index += 1) {
        const event = records[index]?.type === 'event' ? records[index].event : null;
        if (event === null || typeof event !== 'object') continue;
        if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue;
        const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
        if (event.type === 'turn/start') {
          sawTurnStart = true;
        } else if (event.type === 'assistant/message') {
          const value = textOfMessage(data.message);
          if (value.trim() !== '') text = value;
          if (data.usage !== null && typeof data.usage === 'object') usageValue = data.usage;
        } else if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
          calls.set(data.callId, { name: data.name, arguments: data.arguments });
        } else if (event.type === 'turn/end') {
          end = data;
        }
      }
      return {
        completed: lastUserIndex >= 0 && end !== null
          && (historyBaselineSeq !== null || userSeen || turnStarted),
        end,
        text,
        usage: usageValue,
        toolCalls: calls,
        sawUser,
        sawTurnStart,
      };
    };

    /**
     * Re-open the same Session through a fresh SSH proxy and re-check the
     * turn. Resolves the normal completion when the turn already ended while
     * disconnected; otherwise the fresh follow stream delivers the rest.
     */
    const recover = async (cause) => {
      const deadline = Date.now() + reconnectBudgetMs;
      let lastError = cause instanceof Error
        ? cause
        : new AttachError('Host connection closed during exec', 'attach/closed');
      let delay = 500;
      while (!settled && Date.now() < deadline) {
        try {
          await reconnectFn();
          if (settled) return;
          const fresh = nextSnapshot();
          const reopenBudget = Math.min(SNAPSHOT_REOPEN_TIMEOUT_MS, Math.max(1, deadline - Date.now()));
          await awaitWithTimeout(
            client.request('session.open', {
              sessionId,
              ...(typeof cacheRoot === 'string' && cacheRoot !== '' ? { cacheRoot } : {}),
            }),
            reopenBudget,
            'timed out reopening the session after reconnect',
          );
          const frame = await awaitWithTimeout(
            fresh,
            Math.min(SNAPSHOT_REOPEN_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
            'timed out waiting for the fresh snapshot after reconnect',
          );
          if (settled) return;
          const generationAtSnapshot = liveEventGeneration;
          // Connection-owned grants are gone with the old socket.
          if (writableRoots.length > 0) {
            await awaitWithTimeout(
              applyWritableRoots(),
              Math.min(SNAPSHOT_REOPEN_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
              'timed out re-applying writable roots after reconnect',
            );
          }
          if (settled) return;
          const analyzed = analyzeSnapshot(frame);
          // Frames may have arrived while roots were re-applied; those are
          // newer than the snapshot and must win.
          if (liveEventGeneration === generationAtSnapshot) {
            if (analyzed.text !== null) lastText = analyzed.text;
            if (analyzed.usage !== null) usage = analyzed.usage;
          }
          for (const [callId, info] of analyzed.toolCalls) toolCalls.set(callId, info);
          if (analyzed.sawUser) userSeen = true;
          if (analyzed.sawTurnStart) turnStarted = true;
          recovering = false;
          if (analyzed.completed) finishTurn(analyzed.end);
          return;
        } catch (error) {
          lastError = error;
          if (isFatalSshCode(error?.code)) break;
          if (typeof error?.code === 'string' && error.code.startsWith('attach/')
            && !isRetryableAttachCode(error.code)) break;
        }
        if (settled) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        // Wake early when the overall exec timeout or SIGINT settles the run.
        await Promise.race([sleep(Math.min(delay, remaining)), settledSignal]);
        delay = Math.min(delay * 2, 5_000);
      }
      if (settled) return;
      recovering = false;
      if (isFatalSshCode(lastError?.code)) {
        fail(lastError);
        return;
      }
      const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
      fail(new AttachError(
        `Host connection closed during exec and did not recover within `
          + `${Math.round(reconnectBudgetMs / 1000)}s${detail}`,
        'attach/closed',
      ));
    };

    const onInteractiveEvent = (message) => {
      interactiveChain = interactiveChain.then(() => onInteractive(message)).catch(() => {});
    };

    client.on('frame', onFrame);
    client.on('interactive', onInteractiveEvent);
    client.on('session-error', onSessionError);
    client.on('close', onClose);
    client.on('protocol-error', onProtocolError);
    try {
      // Arm the snapshot waiter before opening: a fast Host may deliver the
      // snapshot before `session.open` resolves.
      const firstSnapshot = nextSnapshot();
      await client.request('session.open', {
        sessionId,
        ...(typeof cacheRoot === 'string' && cacheRoot !== '' ? { cacheRoot } : {}),
      });
      await firstSnapshot;
      // Report the resumable id (and real snapshot cwd) before the turn starts.
      notify(onSession, sessionId, { cwd: sessionCwd });
      await applyHostOptions();
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
      client.off('interactive', onInteractiveEvent);
      client.off('session-error', onSessionError);
      client.off('close', onClose);
      client.off('protocol-error', onProtocolError);
    }
  }
}
