import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The interactive terminal application.
 *
 * It renders the live Session stream from the Host bridge, forwards prompts,
 * and turns Host approval/question requests into modal panels.
 */
import {
  CombinedAutocompleteProvider,
  Container,
  KeybindingsManager,
  ProcessTerminal,
  ScrollView,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  VStack,
  isKeyRelease,
  matchesKey,
  setKeybindings,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';

import {
  accent,
  bold,
  cyan,
  dim,
  editorTheme,
  faint,
  green,
  panelBg,
  purple,
  red,
  selectTheme,
  setTheme,
  yellow,
} from './theme.js';
import {
  AssistantRow,
  BlankRow,
  CachedRow,
  NoteRow,
  ReasoningRow,
  StateLine,
  UserRow,
  oneLine,
  partsOfMessage,
  sanitizeText,
  textOfContent,
} from './transcript.js';
import { ApprovalDetailsPanel, ApprovalPanel, FilterList, InfoPanel, JobOutputPanel, LoadingPanel, PickerContainer, PickerPanel, QuestionPanel } from './panels.js';
import { localCommandItems, mergeHostCommands } from './command-catalog.js';
import { AttachEditor } from './editor.js';
import { orderSubagentRows } from './subagent-order.js';
import { mergeActiveSubagentLabels } from './subagent-labels.js';
import { buildPreviewPaneArgs, parsePreviewPaneId } from './herdr-preview.js';
import { applyInboxSplice, emptyInbox, normalizeInbox, removeInboxMessage, removeInboxMessageByText, visibleInboxEntries } from './inbox.js';
import { queueItems, queueSections } from './queue.js';
import { StepActivity } from './step-activity.js';
import { buildSessionTree, sessionLabel } from './session-tree.js';
import { formatAge, shortCwd } from './format.js';
import { autocompleteRow } from './autocomplete-layout.js';
import { HerdrReporter } from './herdr.js';
import { PeekSession } from './peek.js';
import { ClientLog, resolveLogPath } from './log.js';
import { isEscape } from './keys.js';
import { ESCAPE_CANCEL_MS, escapeCancelStep } from './escape-cancel.js';
import { jobIsLive, jobItems, jobTitle, mergeJobEvent, runningJobCount } from './jobs.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class PeekPanel {
  constructor(render) {
    this.renderFn = render;
  }

  render(width) {
    return this.renderFn(width);
  }
}

/** Multi-line pending-inbox display above the composer. */
class QueuePanel {
  constructor(render) {
    this.renderFn = render;
  }

  render(width) {
    return this.renderFn(width);
  }
}
const MAX_TRANSCRIPT_ROWS = 8_000;

function shellArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@%+-]+$/u.test(text) ? text : `'${text.replace(/'/gu, "'\\''")}'`;
}

function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fitLine(left, right, width) {
  const rightText = right ?? '';
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(rightText);
  if (leftWidth + rightWidth + 2 > width) {
    return truncateToWidth(left, width);
  }
  return `${left}${' '.repeat(width - leftWidth - rightWidth)}${rightText}`;
}

/** Resolve after `ms` with `fallback` if a supporting request is slow. */
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Opaque overlay rendering the editor's current suggestion block. */
class AutocompletePanel {
  constructor() {
    this.lines = [];
  }

  setLines(lines) {
    this.lines = lines;
  }

  render(width) {
    return this.lines.map((line) => {
      const clipped = truncateToWidth(line, width);
      const padding = ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
      return panelBg(clipped) + panelBg(padding);
    });
  }
}

/** Attach TUI application. */
export class AttachApp {
  constructor(client, options = {}) {
    this.client = client;
    this.options = options;
    this.theme = setTheme(options.theme ?? 'light');
    this.state = {
      sessionId: null,
      title: null,
      cwd: options.cwd ?? process.cwd(),
      running: false,
      turn: 0,
      step: 0,
      reason: null,
      provider: null,
      model: null,
      contextWindow: null,
      contextTokens: 0,
      tokens: null,
      todos: [],
      goal: null,
      permission: null,
      preset: null,
      plan: null,
      note: null,
      connected: true,
      interactive: null,
      sessionCount: 0,
      subagent: false,
      parentSessionId: null,
      subagents: { total: 0, running: 0, items: [] },
    };
    this.herdr = new HerdrReporter(process.env);
    const logPath = options.logPath === 'off' ? null : options.logPath ?? resolveLogPath();
    this.log = new ClientLog(logPath);
    this.log.start(process.argv.slice(2));
    this.#installDiagnostics();
    this.rows = [];
    this.rowWrappers = new Map();
    this.steps = new StepActivity({
      addRow: (row) => this.#addRow(row),
      removeRow: (row) => this.#removeRow(row),
      requestRender: () => this.tui.requestRender(),
      isGroupExpanded: () => this.showCommandGroups,
      isToolExpanded: () => this.showTools,
    });
    this.echoes = [];
    this.inbox = emptyInbox();
    this.queueManagerHandle = null;
    this.queueManagerPanel = null;
    this.queueManagerList = null;
    this.queueRemoveArmed = null;
    this.queueRemoveTimer = null;
    this.queueDetailsHandle = null;
    this.queueDetailsId = null;
    this.queueDetailsReturnToQueue = false;
    this.live = null;
    this.spin = 0;
    this.showReasoning = false;
    this.showTools = false;
    this.showCommandGroups = false;
    this.quitting = false;
    this.lastRejectionAt = 0;
    this.infoHandle = null;
    this.pickerHandle = null;
    this.activeInteractive = null;
    this.approvalDetails = null;
    this.interactiveQueue = [];
    this.exit = Promise.withResolvers();
    this.throttle = null;
    this.escapePendingAt = null;
    this.escapeTimer = null;
    this.ctrlCPendingAt = null;
    this.ctrlCTimer = null;
    this.terminalFocused = true;
    this.jobsHandle = null;
    this.jobsPanel = null;
    this.jobsList = null;
    this.jobsTimer = null;
    this.jobsRefreshInFlight = false;
    this.jobRoster = new Map();
    this.jobKillArmed = null;
    this.jobKillTimer = null;
    this.jobOutputHandle = null;
    this.jobOutputPanel = null;
    this.jobOutputJob = null;
    this.jobOutputFrom = 0;
    this.jobOutputText = '';
    this.jobOutputLossy = false;
    this.jobOutputReading = false;
    this.jobOutputReturnToJobs = false;
    this.jobOutputTimer = null;
    this.hostCommands = [];
    this.autocomplete = null;
    this.autocompleteCwd = null;
    this.hostCommandWarningShown = false;
    this.hostVersionWarningShown = false;
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    this.subagentPoll = null;
    this.subagentRefreshInFlight = false;
    this.subagentRefreshQueued = false;
    this.subagentRefreshTimer = null;
    this.subagentPollTick = 0;
    this.subagentSummarySupported = false;
    this.subagentListSupported = null;
    this.subagentLabels = new Map();
    this.sessionListCache = null;
    this.sessionListRequest = null;
    this.workspaceCache = null;
    this.previewedChildren = new Set();
    this.previewPanes = new Set();
    this.peekEnabled = true;
    this.peeks = new Map();
    this.peekRenderTimer = null;
    this.perf = process.env.DSH_ATTACH_PERF === '1';
    this.loopTimer = null;
    this.autocompletePanel = null;
    this.autocompleteHandle = null;
    this.autocompleteKey = null;
    this.autocompleteWidth = null;
    this.autocompleteRow = null;
    this.autocompleteHeight = null;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async run() {
    this.#buildTui();
    this.tui.start();
    if (process.env.DSH_ATTACH_NO_MOUSE !== '1' && process.env.DSH_ATTACH_FULL_MOUSE !== '1') {
      // pi-tui requests all-motion mouse tracking (1003). Button-motion (1002)
      // is enough for wheel, click and drag selection, and avoids a flood of
      // motion events in terminals such as Herdr/iTerm2.
      process.stdout.write('\x1b[?1003l');
    }
    this.subagentSummarySupported = this.client.host?.capabilities?.includes('subagent.summary') === true;
    if (this.perf) {
      let lastLoop = performance.now();
      this.loopTimer = setInterval(() => {
        const now = performance.now();
        const lag = now - lastLoop - 1_000;
        lastLoop = now;
        if (lag > 100) this.log.event('loop-lag', { ms: Number(lag.toFixed(1)) });
      }, 1_000);
      this.loopTimer.unref?.();
    }
    this.spinner = setInterval(() => {
      if (this.quitting) return;
      this.spin = (this.spin + 1) % SPINNER.length;
      if (this.state.running || this.activeInteractive !== null) this.tui.requestRender();
    }, 120);
    this.spinner.unref?.();
    // Keep this terminal the active answerer for `auto` routing, including
    // while a long turn is running and the user has not typed recently.
    this.#startHeartbeat();
    this.subagentPoll = setInterval(() => {
      if (this.quitting || !this.state.connected || this.state.sessionId === null) return;
      if (!this.state.running && this.state.subagents.running === 0) return;
      this.subagentPollTick += 1;
      // Older Hosts have no summary route and require a full session.list;
      // poll them less often. New Hosts use the small counter response.
      if (!this.subagentSummarySupported && this.subagentPollTick % 3 !== 0) return;
      void this.#refreshSubagents();
    }, 4_000);
    this.subagentPoll.unref?.();

    this.client.on('frame', (message) => this.#onFrame(message));
    this.client.on('session-error', (message) => this.#onSessionError(message));
    this.client.on('interactive', (message) => this.#enqueueInteractive(message));
    this.client.on('interactive-closed', (message) => this.#onInteractiveClosed(message));
    this.client.on('protocol-error', (error) => this.#note(`Host protocol error: ${error.message}`, 'error'));
    this.client.on('close', () => this.#onHostClose());

    try {
      if (this.options.session) {
        await this.#openSession(this.options.session);
      } else if (this.options.createNew === true) {
        await this.#createSession();
      } else {
        await this.#showSessionPicker();
      }
    } catch (error) {
      this.#note(error instanceof Error ? error.message : String(error), 'error');
      if (this.state.sessionId === null) {
        this.#note('No session is open. Press ctrl+c to exit, or run with --session.', 'warn');
      }
    }
    if (this.options.prompt) {
      await this.#submitPrompt(this.options.prompt, 'queue');
    }
    // Warm the picker cache when the client opened a known session directly.
    // The initial picker already fetches these lists on its own.
    if (this.options.session || this.options.createNew === true) {
      const warm = setTimeout(() => {
        if (this.quitting || this.state.sessionId === null) return;
        void this.#fetchAllSessions().catch(() => {});
        void this.#fetchWorkspaces();
      }, 1_000);
      warm.unref?.();
    }
    await this.exit.promise;
  }

  #buildTui() {
    // Emacs-style navigation everywhere: Ctrl-N/P move in the editor, the
    // completion list, and the pickers (the latter two handle raw keys too).
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
      'tui.editor.cursorUp': ['up', 'ctrl+p'],
      'tui.editor.cursorDown': ['down', 'ctrl+n'],
      'tui.select.up': ['up', 'ctrl+p'],
      'tui.select.down': ['down', 'ctrl+n'],
    }));
    this.terminal = this.options.terminal ?? new ProcessTerminal();
    const mouse = process.env.DSH_ATTACH_NO_MOUSE !== '1';
    this.tui = this.options.tui ?? new TuiAltScreen(this.terminal, true, undefined, { mouse, wheelScrollLines: 3 });
    if (process.env.DSH_ATTACH_PERF === '1') {
      const renderFrame = this.tui.doRender.bind(this.tui);
      let frames = 0;
      let totalMs = 0;
      let maxMs = 0;
      this.tui.doRender = () => {
        const started = performance.now();
        renderFrame();
        const elapsed = performance.now() - started;
        frames += 1;
        totalMs += elapsed;
        maxMs = Math.max(maxMs, elapsed);
        if (frames >= 50) {
          this.log.event('frame-stats', {
            frames,
            avgMs: Number((totalMs / frames).toFixed(2)),
            maxMs: Number(maxMs.toFixed(2)),
            heapMb: Number((process.memoryUsage().heapUsed / 1_048_576).toFixed(1)),
          });
          frames = 0;
          totalMs = 0;
          maxMs = 0;
        }
      };
    }
    const viewportInput = this.tui.handleViewportInput?.bind(this.tui);
    if (viewportInput !== undefined) {
      this.tui.handleViewportInput = (data) => {
          if (data === '\x1b[O') {
          this.terminalFocused = false;
          this.#clearCtrlC();
          this.log.throttled('focus', 2_000, { state: 'out' }, 'focus');
          this.editor?.setTerminalFocused(false);
          this.tui.requestRender();
        } else if (data === '\x1b[I') {
          this.terminalFocused = true;
          this.#clearCtrlC();
          this.log.throttled('focus', 2_000, { state: 'in' }, 'focus');
          this.editor?.setTerminalFocused(true);
          this.tui.requestRender();
        }
        return viewportInput(data);
      };
    }
    this.document = new Container();
    this.transcript = new ScrollView(this.document, {
      follow: 'end',
      primary: true,
      overscroll: 'contain',
      scrollbar: 'auto',
      scrollbarStyle: faint,
    });
    this.header = new StateLine((width) => this.#renderHeader(width));
    this.activity = new StateLine((width) => this.#renderActivity(width));
    this.peekPanel = new PeekPanel((width) => this.#renderPeek(width));
    this.pendingQueuePanel = new QueuePanel((width) => this.#renderQueue(width));
    this.footer = new StateLine((width) => this.#renderFooter(width));
    this.editor = new AttachEditor(this.tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
    this.autocompletePanel = new AutocompletePanel();
    this.#installAutocomplete();
    this.editor.onAutocompleteChange = () => {
      if (this.autocompleteHandle !== null || this.editor.isShowingAutocomplete()) this.#syncAutocomplete();
    };
    this.editor.onSubmit = (text) => {
      void this.#onSubmit(text);
    };
    // Run the preview refresh immediately after the editor has processed the
    // key, still inside the same input turn. The renderer's latency-sensitive
    // immediate frame then paints the moved selection instead of a stale list
    // (and we never move the list a second time from the global listener).
    this.editor.onAfterInput = () => {
      const showing = this.editor.isShowingAutocomplete();
      if (showing || this.autocompleteHandle !== null) this.#syncAutocomplete();
      if (!showing) {
        // A bare "/" starts the provider asynchronously; catch the list when it
        // opens just after this input turn.
        queueMicrotask(() => {
          if (this.editor.isShowingAutocomplete() || this.autocompleteHandle !== null) this.#syncAutocomplete();
        });
        setTimeout(() => {
          if (this.editor.isShowingAutocomplete() || this.autocompleteHandle !== null) this.#syncAutocomplete();
        }, 0);
      }
    };
    this.layout = new VStack([
      { component: this.header, basis: 'auto', shrink: 0, maxSize: 1 },
      { component: this.transcript, basis: 0, grow: 1, shrink: 1, minSize: 2 },
      { component: this.peekPanel, basis: 'auto', shrink: 1, maxSize: 7 },
      { component: this.pendingQueuePanel, basis: 'auto', shrink: 1, maxSize: 5 },
      { component: this.activity, basis: 'auto', shrink: 1, maxSize: 3 },
      { component: this.editor, basis: 'auto', shrink: 1, minSize: 3, maxSize: 12 },
      { component: this.footer, basis: 'auto', shrink: 0, maxSize: 2 },
    ]);
    this.tui.setLayoutRoot(this.layout);
    this.tui.setFocus(this.editor);
    this.resizeHandler = () => {
      if (this.autocompleteHandle !== null || this.editor.isShowingAutocomplete()) this.#syncAutocomplete();
    };
    process.stdout.on('resize', this.resizeHandler);
    this.tui.addInputListener((data) => {
      if (this.perf) {
        const started = performance.now();
        setImmediate(() => this.log.event('input-latency', { ms: Number((performance.now() - started).toFixed(1)) }));
      }
      if (process.env.DSH_ATTACH_KEYS === '1') this.log.event('key', { data: JSON.stringify(data) });
      const keyRelease = isKeyRelease(data);
      const ctrlC = !keyRelease && matchesKey(data, 'ctrl+c');
      if (!keyRelease) {
        if (!isEscape(data)) this.#clearEscapeCancel();
        if (!ctrlC) this.#clearCtrlC();
      }
      if (ctrlC) {
        if (this.ctrlCPendingAt !== null && Date.now() - this.ctrlCPendingAt <= 2_000) {
          this.#clearCtrlC({ render: true });
          this.quit('ctrl+c');
        } else {
          this.#armCtrlC();
        }
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+t')) {
        this.showReasoning = !this.showReasoning;
        for (const row of this.rows) if (row instanceof ReasoningRow) row.invalidate?.();
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+o')) {
        this.showTools = !this.showTools;
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+g')) {
        this.showCommandGroups = !this.showCommandGroups;
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+l')) {
        this.transcript.scrollToEnd();
        this.tui.requestRender();
        return { consume: true };
      }
      const overlayOpen = this.pickerHandle !== null || this.infoHandle !== null || this.activeInteractive !== null || this.jobsHandle !== null || this.jobOutputHandle !== null || this.queueManagerHandle !== null || this.queueDetailsHandle !== null;
      if (overlayOpen) {
        this.#clearEscapeCancel();
        return undefined;
      }
      if (isEscape(data) && this.state.running && !this.state.subagent) {
        if (this.editor.isShowingAutocomplete() || this.autocompleteHandle !== null) {
          this.#clearEscapeCancel();
          return undefined;
        }
        const step = escapeCancelStep(this.escapePendingAt);
        if (step.cancel) {
          this.#clearEscapeCancel({ render: true });
          void this.#cancelTurn('escape');
        } else {
          this.#armEscapeCancel(step.pendingAt);
        }
        return { consume: true };
      }
      if (!overlayOpen) {
        if (
          matchesKey(data, 'pageup') ||
          matchesKey(data, 'shift+pageup') ||
          matchesKey(data, 'alt+v') ||
          matchesKey(data, 'ctrl+alt+b')
        ) {
          this.#scrollTranscript(-1);
          return { consume: true };
        }
        if (
          matchesKey(data, 'pagedown') ||
          matchesKey(data, 'shift+pagedown') ||
          matchesKey(data, 'ctrl+v') ||
          matchesKey(data, 'ctrl+alt+f')
        ) {
          this.#scrollTranscript(1);
          return { consume: true };
        }
        if (matchesKey(data, 'ctrl+home')) {
          this.transcript.scrollToStart();
          this.tui.requestRender();
          return { consume: true };
        }
        if (matchesKey(data, 'ctrl+end')) {
          this.transcript.scrollToEnd();
          this.tui.requestRender();
          return { consume: true };
        }
      }
      // The Editor owns completion navigation through the keybindings
      // (`tui.select.up/down`, which include Ctrl-P/N). Refresh the floating
      // preview just after it handles the key; moving the list here as well
      // would advance two entries per press.
      return undefined;
    });
  }

  quit(reason = 'unknown', exitCode = 0) {
    if (this.quitting) return;
    this.quitting = true;
    const sessionId = this.state.sessionId;
    this.log.event('quit', {
      reason,
      pane: process.env.HERDR_PANE_ID ?? null,
      workspace: process.env.HERDR_WORKSPACE_ID ?? null,
      focused: this.terminalFocused,
      stack: new Error().stack?.split('\n').slice(0, 8).join('\n'),
    });
    if (exitCode !== 0) process.exitCode = exitCode;
    this.#clearReconnect();
    this.#clearCtrlC();
    clearInterval(this.spinner);
    clearInterval(this.heartbeat);
    clearInterval(this.subagentPoll);
    clearInterval(this.loopTimer);
    clearTimeout(this.peekRenderTimer);
    clearTimeout(this.subagentRefreshTimer);
    this.subagentRefreshTimer = null;
    this.#stopPeeks();
    this.#hideApprovalDetails();
    this.#clearEscapeCancel();
    this.#closeQueueDetails({ showNext: false, focus: false, returnToQueue: false });
    this.#closeQueueManager({ showNext: false, focus: false });
    this.#closeJobsPanel({ showNext: false, focus: false });
    this.#closeJobOutput({ showNext: false, focus: false });
    if (this.throttle !== null) clearTimeout(this.throttle);
    this.herdr?.release();
    this.client?.close();
    try {
      this.tui?.stop();
    } catch {
      // The terminal may already be gone.
    }
    if (
      typeof sessionId === 'string' &&
      sessionId !== '' &&
      (reason === 'ctrl+c' || reason === 'command') &&
      exitCode === 0 &&
      process.stderr.isTTY === true &&
      process.env.DSH_ATTACH_NO_EXIT_HINT !== '1'
    ) {
      process.stderr.write(`\nReattach with: ${this.#herdrResumeArgv(sessionId).map(shellArg).join(' ')}\n`);
    }
    this.#disposeDiagnostics();
    this.exit?.resolve();
  }

  #disposeDiagnostics() {
    if (this.resizeHandler !== undefined) {
      process.stdout.off('resize', this.resizeHandler);
      this.resizeHandler = undefined;
    }
    for (const [signal, handler] of this.signalHandlers ?? []) {
      process.off(signal, handler);
    }
    this.signalHandlers?.clear();
    if (this.uncaughtHandler !== undefined) process.off('uncaughtException', this.uncaughtHandler);
    if (this.rejectionHandler !== undefined) process.off('unhandledRejection', this.rejectionHandler);
    if (this.exitHandler !== undefined) process.off('exit', this.exitHandler);
    if (this.beforeExitHandler !== undefined) process.off('beforeExit', this.beforeExitHandler);
    if (this.stdinEndHandler !== undefined) process.stdin.off('end', this.stdinEndHandler);
    if (this.stdinCloseHandler !== undefined) process.stdin.off('close', this.stdinCloseHandler);
    if (this.stdinErrorHandler !== undefined) process.stdin.off('error', this.stdinErrorHandler);
  }

  #clearEscapeCancel({ render = false } = {}) {
    if (this.escapeTimer !== null) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = null;
    }
    this.escapePendingAt = null;
    if (render) this.tui?.requestRender();
  }

  #clearCtrlC({ render = false } = {}) {
    if (this.ctrlCTimer !== null) {
      clearTimeout(this.ctrlCTimer);
      this.ctrlCTimer = null;
    }
    this.ctrlCPendingAt = null;
    if (render) this.tui?.requestRender();
  }

  #armCtrlC() {
    this.#clearCtrlC();
    this.ctrlCPendingAt = Date.now();
    this.log.event('ctrl-c-armed', {
      pane: process.env.HERDR_PANE_ID ?? null,
      focused: this.terminalFocused,
    });
    this.ctrlCTimer = setTimeout(() => {
      this.ctrlCTimer = null;
      this.ctrlCPendingAt = null;
      this.tui.requestRender();
    }, 2_000);
    this.ctrlCTimer.unref?.();
    this.tui.requestRender();
  }

  #armEscapeCancel(pendingAt = Date.now()) {
    this.#clearEscapeCancel();
    this.escapePendingAt = pendingAt;
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = null;
      this.escapePendingAt = null;
      this.tui.requestRender();
    }, ESCAPE_CANCEL_MS);
    this.escapeTimer.unref?.();
    this.tui.requestRender();
  }

  async #cancelTurn(source = 'command') {
    if (this.state.subagent) {
      this.#note('Subagent interrupt is not wired yet; use the Web UI or /parent.', 'warn');
      return;
    }
    try {
      await this.client.request('session.cancel');
      this.log?.event('cancel', { source });
      this.#note('cancel requested', 'warn');
    } catch (error) {
      this.#note(`cancel failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  #startHeartbeat() {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.quitting || !this.state.connected || this.state.sessionId === null) return;
      void this.client.activity();
    }, 20_000);
    this.heartbeat.unref?.();
  }

  #clearReconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
  }

  #reconnectOptions() {
    const options = { timeoutMs: 2_500 };
    if (typeof this.options.endpoint === 'string' && this.options.endpoint !== '') options.endpoint = this.options.endpoint;
    if (typeof this.options.profile === 'string' && this.options.profile !== '') options.profile = this.options.profile;
    if (typeof this.options.socketPath === 'string' && this.options.socketPath !== '' && typeof this.options.token === 'string') {
      options.socketPath = this.options.socketPath;
      options.token = this.options.token;
    }
    return options;
  }

  #scheduleReconnect() {
    if (this.quitting || this.state.connected || this.reconnecting || this.reconnectTimer !== null) return;
    const delays = [500, 1_000, 2_000, 5_000];
    const delay = delays[Math.min(this.reconnectAttempts, delays.length - 1)];
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.#reconnectOnce();
    }, delay);
    this.reconnectTimer.unref?.();
    this.tui.requestRender();
  }

  async #reconnectOnce() {
    if (this.quitting || this.state.connected || this.reconnecting) return;
    this.reconnecting = true;
    const sessionId = this.state.sessionId;
    const parentSessionId = this.state.parentSessionId;
    this.tui.requestRender();
    try {
      await this.client.reconnect(this.#reconnectOptions());
      if (this.quitting) {
        this.client.close();
        return;
      }
      this.state.connected = true;
      this.state.note = null;
      this.reconnectAttempts = 0;
      this.sessionListCache = null;
      this.workspaceCache = null;
      this.log.event('reconnect', { sessionId });
      this.#startHeartbeat();
      if (sessionId !== null) {
        try {
          await this.#openSession(sessionId, { parentSessionId, quiet: true });
        } catch (error) {
          this.state.sessionId = sessionId;
          this.state.parentSessionId = parentSessionId;
          throw error;
        }
      }
      this.#note('Host reconnected', 'ok');
      this.#warnHostVersion();
      void this.#refreshHostCommands();
      void this.#refreshSubagents();
      this.#reportHerdr();
    } catch (error) {
      this.state.connected = false;
      this.reconnectAttempts += 1;
      this.log.event('reconnect-failed', {
        attempt: this.reconnectAttempts,
        message: error instanceof Error ? error.message : String(error),
      });
      this.#scheduleReconnect();
    } finally {
      this.reconnecting = false;
      if (!this.quitting) this.tui.requestRender();
    }
  }

  /** Rebuild the editor's slash-command / path autocomplete provider. */
  #scrollTranscript(pages) {
    const viewport = Math.max(1, this.transcript?.viewportHeight ?? 10);
    this.transcript?.scrollBy(pages * Math.max(1, viewport - 1));
    this.tui.requestRender();
  }

  #installDiagnostics() {
    this.log.event('diagnostics', { logPath: this.log.path });
    this.signalHandlers = new Map();
    for (const [signal, code] of [['SIGHUP', 129], ['SIGTERM', 143], ['SIGINT', 130], ['SIGQUIT', 131]]) {
      const handler = () => {
        this.log.event('signal', { signal });
        this.quit(`signal:${signal}`, code);
      };
      process.on(signal, handler);
      this.signalHandlers.set(signal, handler);
    }
    this.uncaughtHandler = (error) => {
      this.log.event('uncaughtException', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      this.quit('uncaughtException', 1);
    };
    this.rejectionHandler = (reason) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      this.log.event('unhandledRejection', { reason: message, stack: reason instanceof Error ? reason.stack : undefined });
      if (this.quitting) return;
      // A rejected UI callback should not discard a live session. Report it in
      // the transcript, rate-limited so a failing stream cannot flood the view.
      const now = Date.now();
      if (now - this.lastRejectionAt < 5_000) return;
      this.lastRejectionAt = now;
      this.#note(`internal error: ${oneLine(message, 160)}; continuing`, 'error');
      this.tui?.requestRender();
    };
    process.on('uncaughtException', this.uncaughtHandler);
    process.on('unhandledRejection', this.rejectionHandler);
    this.exitHandler = (code) => this.log.event('process-exit', { code });
    process.on('exit', this.exitHandler);
    this.beforeExitHandler = (code) => this.log.event('before-exit', { code });
    process.on('beforeExit', this.beforeExitHandler);
    this.stdinEndHandler = () => {
      this.log.event('stdin-end');
      this.quit('stdin-end', 0);
    };
    this.stdinCloseHandler = () => {
      this.log.event('stdin-close');
      // A close without an end can otherwise leave only unref'd timers, letting
      // the process exit with no quit line. Treat it like a lost pty.
      this.quit('stdin-close', 0);
    };
    this.stdinErrorHandler = (error) => {
      this.log.event('stdin-error', { message: error instanceof Error ? error.message : String(error) });
      this.quit('stdin-error', 1);
    };
    process.stdin.on('end', this.stdinEndHandler);
    process.stdin.on('close', this.stdinCloseHandler);
    process.stdin.on('error', this.stdinErrorHandler);
  }

  #scheduleSubagentRefresh() {
    if (!this.subagentSummarySupported && this.state.running) return;
    if (this.subagentRefreshTimer !== null) return;
    this.subagentRefreshTimer = setTimeout(() => {
      this.subagentRefreshTimer = null;
      void this.#refreshSubagents();
    }, 1_000);
    this.subagentRefreshTimer.unref?.();
  }

  async #fallbackSubagentRows(rootId, { recursive = true } = {}) {
    const all = await this.#fetchAllSessions();
    const childrenByParent = new Map();
    for (const session of all) {
      if (session.origin !== 'subagent') continue;
      const parent = String(session.parentSessionId ?? '');
      if (parent === '') continue;
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
      childrenByParent.get(parent).push(session);
    }
    const rows = [];
    const visited = new Set();
    const walk = (parentId) => {
      for (const child of childrenByParent.get(parentId) ?? []) {
        const id = String(child.sessionId);
        if (visited.has(id)) continue;
        visited.add(id);
        rows.push({
          id,
          parentSessionId: String(child.parentSessionId ?? parentId),
          mode: 'unknown',
          activity: child.running === true ? 'running' : 'inactive',
          label: sessionLabel(child),
        });
        if (recursive) walk(id);
      }
    };
    walk(String(rootId));
    return rows;
  }

  /**
   * Older Hosts omit catalog labels from `subagent.summary`. Resolve them from
   * `subagent.list` on demand and cache them for the current active set.
   */
  async #labelActiveSubagents(sessionId, active) {
    if (active.length === 0) {
      this.subagentLabels.clear();
      return active;
    }
    const wanted = new Set(active.map((item) => String(item.id)));
    for (const id of this.subagentLabels.keys()) {
      if (!wanted.has(id)) this.subagentLabels.delete(id);
    }
    const missing = active.some((item) => {
      const own = typeof item.label === 'string' ? item.label.trim() : '';
      return own === '' && !this.subagentLabels.has(String(item.id));
    });
    if (missing && this.subagentListSupported !== false) {
      try {
        const value = await this.client.request('subagent.list', { sessionId });
        if (value?.supported === true) {
          this.subagentListSupported = true;
          for (const id of wanted) {
            if (!this.subagentLabels.has(id)) this.subagentLabels.set(id, null);
          }
          for (const row of Array.isArray(value.items) ? value.items : []) {
            const id = row?.id === undefined ? '' : String(row.id);
            const label = typeof row.label === 'string' ? row.label.trim() : '';
            if (wanted.has(id) && label !== '') this.subagentLabels.set(id, label);
          }
        } else {
          this.subagentListSupported = false;
        }
      } catch (error) {
        this.log.event('subagent-labels-error', {
          message: error instanceof Error ? error.message : String(error),
        });
        if (error?.code === 'attach/unknown-method') this.subagentListSupported = false;
      }
    }
    return mergeActiveSubagentLabels(active, this.subagentLabels);
  }

  /** Refresh the current session's subagent summary without blocking the UI. */
  async #refreshSubagents() {
    if (this.quitting || this.state.sessionId === null) return;
    if (this.subagentRefreshInFlight) {
      this.subagentRefreshQueued = true;
      return;
    }
    this.subagentRefreshInFlight = true;
    const sessionId = this.state.sessionId;
    try {
      let total = null;
      let running = 0;
      let active = [];
      if (this.subagentSummarySupported) {
        try {
          const value = await this.client.request('subagent.summary', { sessionId });
          if (value?.supported === true) {
            total = Math.max(0, Number(value.total) || 0);
            running = Math.max(0, Number(value.running) || 0);
            active = Array.isArray(value.active)
              ? value.active
                  .filter((item) => item !== null && item !== undefined && item.id !== undefined)
                  .map((item) => ({
                    id: String(item.id),
                    parentSessionId: item.parentSessionId === undefined ? null : String(item.parentSessionId),
                    title: typeof item.title === 'string' ? item.title : null,
                    label: typeof item.label === 'string' && item.label.trim() !== '' ? item.label : null,
                  }))
              : [];
          }
        } catch {
          // Older Host: fall back to session.list below.
        }
      }
      if (total === null) {
        // The catalog route can wait on the followed Session's observation;
        // session.list is the reliable fallback for older Hosts.
        const rows = await this.#fallbackSubagentRows(sessionId, { recursive: true });
        if (this.quitting || this.state.sessionId !== sessionId) return;
        total = rows.length;
        running = rows.filter((row) => row.activity === 'running').length;
        active = rows
          .filter((row) => row.activity === 'running')
          .map((row) => ({
            id: String(row.id),
            parentSessionId: row.parentSessionId ?? null,
            title: row.label ?? null,
          }));
      }
      if (active.length > 0) active = await this.#labelActiveSubagents(sessionId, active);
      if (this.quitting || this.state.sessionId !== sessionId) return;
      const previous = this.state.subagents;
      const changed = previous.total !== total || previous.running !== running;
      this.state.subagents = { total, running, items: active };
      this.#reconcilePeeks(active);
      if (changed) {
        this.log.event('subagents', { sessionId, total, running });
        this.tui.requestRender();
        this.#reportHerdr();
      }
    } catch (error) {
      this.log.event('subagents-error', { message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.subagentRefreshInFlight = false;
      if (this.subagentRefreshQueued) {
        this.subagentRefreshQueued = false;
        this.#scheduleSubagentRefresh();
      }
    }
  }

  #herdrResumeArgv(sessionId) {
    const argv = ['dsh-attach'];
    if (typeof this.options.profile === 'string' && this.options.profile !== '') argv.push('--profile', this.options.profile);
    if (typeof this.options.endpoint === 'string' && this.options.endpoint !== '') argv.push('--endpoint', this.options.endpoint);
    if (this.options.theme === 'dark') argv.push('--theme', 'dark');
    argv.push('--reattach', sessionId);
    return argv;
  }

  #herdrBlockedMessage() {
    const item = this.activeInteractive ?? this.interactiveQueue[0];
    if (item === undefined || item === null) return undefined;
    if (item.type === 'approval') {
      const display = item.displayReason;
      const localized =
        typeof display === 'string'
          ? display
          : display !== null && typeof display === 'object'
            ? display.zh ?? display.en ?? Object.values(display).find((value) => typeof value === 'string')
            : '';
      const reason = localized || item.reason || '';
      const text = `${item.toolName ?? 'tool'} approval${reason === '' ? '' : `: ${reason}`}`;
      return oneLine(sanitizeText(text), 140);
    }
    const question = item.questions?.[0];
    const prompt = question?.question ?? question?.prompt ?? question?.header ?? '';
    const text = `question${typeof prompt === 'string' && prompt !== '' ? `: ${prompt}` : ''}`;
    return oneLine(sanitizeText(text), 140);
  }

  #reportHerdr(forcedState) {
    if (this.herdr?.active !== true) return;
    const sessionId = this.state.sessionId;
    if (sessionId === null || sessionId === '') return;
    const subagentRunning = this.state.subagents?.running ?? 0;
    const state =
      forcedState ??
      (this.activeInteractive !== null || this.interactiveQueue.length > 0
        ? 'blocked'
        : this.state.running || subagentRunning > 0
          ? 'working'
          : 'idle');
    const title = oneLine(sanitizeText(typeof this.state.title === 'string' && this.state.title.trim() !== '' ? this.state.title : sessionId), 80);
    this.herdr.report(state, {
      message: state === 'blocked' ? this.#herdrBlockedMessage() : undefined,
      sessionId,
      resume: this.#herdrResumeArgv(sessionId),
    });
    this.herdr.reportTitle(title);
  }

  #installAutocomplete() {
    if (this.editor === undefined) return;
    const cwd = this.state.cwd ?? process.cwd();
    const commands = mergeHostCommands(localCommandItems(this.client), this.hostCommands);
    this.autocomplete = new CombinedAutocompleteProvider(commands, cwd);
    this.editor.setAutocompleteProvider(this.autocomplete);
    this.autocompleteCwd = cwd;
  }

  #warnHostVersion() {
    if (this.hostVersionWarningShown) return;
    const version = this.client.host?.pluginVersion;
    const minimum = [0, 10, 0];
    const parsed = typeof version === 'string' ? version.split('.').map((part) => Number.parseInt(part, 10)) : [];
    const older =
      typeof version === 'string' &&
      parsed.length >= 3 &&
      (parsed[0] < minimum[0] ||
        (parsed[0] === minimum[0] && parsed[1] < minimum[1]) ||
        (parsed[0] === minimum[0] && parsed[1] === minimum[1] && parsed[2] < minimum[2]));
    if (older) {
      this.hostVersionWarningShown = true;
      this.#note(
        `Host plugin ${version} is older than 0.10.0. Restart DeepSeek Harness to load pending-approval replay and Host command execution.`,
        'warn',
      );
    }
  }

  /** Discover Host-registered commands for the current Session. */
  async #refreshHostCommands() {
    const sessionId = this.state.sessionId;
    try {
      const value = await this.client.request('commands.list');
      if (this.state.sessionId !== sessionId) return;
      this.hostCommands = Array.isArray(value?.commands) ? value.commands : [];
    } catch (error) {
      if (this.state.sessionId !== sessionId) return;
      this.hostCommands = [];
      if (error?.code === 'attach/unknown-method' && this.hostCommandWarningShown !== true) {
        this.hostCommandWarningShown = true;
        this.#note('Host command completion needs one app restart to load the new bridge; local commands already work.', 'warn');
      }
    }
    this.#installAutocomplete();
  }

  /** Draw or hide the suggestion block above the composer without moving it. */
  #syncAutocomplete() {
    if (this.quitting) return;
    if (this.infoHandle !== null || this.pickerHandle !== null || this.activeInteractive !== null || this.jobsHandle !== null || this.jobOutputHandle !== null || this.queueManagerHandle !== null || this.queueDetailsHandle !== null) {
      this.#hideAutocomplete();
      return;
    }
    const width = this.terminal?.columns ?? 80;
    let snapshot;
    try {
      snapshot = this.editor.snapshot(width);
    } catch {
      snapshot = { editor: [], autocomplete: [] };
    }
    const lines = snapshot.autocomplete;
    if (lines.length === 0) {
      this.#hideAutocomplete();
      return;
    }
    const editorHeight = snapshot.editor.length;
    const footerHeight = this.footer.render(width).length;
    const activityHeight = this.activity.render(width).length;
    const queueHeight = this.pendingQueuePanel?.render(width).length ?? 0;
    const peekHeight = this.peekPanel.render(width).length;
    const rows = this.terminal?.rows ?? 24;
    const row = autocompleteRow({
      rows,
      editorHeight,
      footerHeight,
      activityHeight,
      queueHeight,
      peekHeight,
      lineCount: lines.length,
    });
    const key = `${width}:${row}:${lines.length}:${lines.join('\n')}`;
    if (key === this.autocompleteKey) return;
    this.autocompleteKey = key;
    this.autocompletePanel.setLines(lines);
    const geometryChanged =
      this.autocompleteHandle === null ||
      this.autocompleteWidth !== width ||
      this.autocompleteRow !== row ||
      this.autocompleteHeight !== lines.length;
    if (geometryChanged) {
      this.autocompleteHandle?.hide();
      this.autocompleteHandle = this.tui.showOverlay(this.autocompletePanel, {
        row,
        col: 0,
        width,
        maxHeight: lines.length,
        nonCapturing: true,
      });
      this.autocompleteWidth = width;
      this.autocompleteRow = row;
      this.autocompleteHeight = lines.length;
    } else {
      // Same geometry: mutate the overlay's content and repaint it in place,
      // instead of destroying/recreating the overlay for every selection move.
      this.tui.requestRender();
    }
  }

  #hideAutocomplete() {
    if (this.autocompleteHandle !== null) {
      this.autocompleteHandle.hide();
      this.autocompleteHandle = null;
    }
    this.autocompleteKey = null;
    this.autocompleteWidth = null;
    this.autocompleteRow = null;
    this.autocompleteHeight = null;
  }

  // ── rendering ────────────────────────────────────────────────────────────

  #renderHeader(width) {
    const state = this.state;
    const dot = state.connected ? (state.running ? green('●') : faint('●')) : red('●');
    const rawTitle = state.title !== null && state.title.trim() !== '' ? sanitizeText(state.title) : state.sessionId !== null ? `session ${state.sessionId.slice(0, 12)}` : 'no session';
    const title = state.subagent ? `↳ ${rawTitle}` : rawTitle;
    const subagents = state.subagents;
    const agentBadge =
      subagents !== undefined && subagents !== null && subagents.total > 0
        ? ` ${dim('·')} ${
            subagents.running > 0
              ? green(`agents ${subagents.running}/${subagents.total}`)
              : faint(`agents ${subagents.total}`)
          }`
        : '';
    const left = `${dot} ${bold(accent('DSH'))} ${dim('·')} ${bold(title)}${agentBadge}`;
    const right = state.cwd ? faint(shortCwd(state.cwd, Math.max(12, Math.floor(width / 3)))) : '';
    return fitLine(left, right, width);
  }

  #schedulePeekRender() {
    if (this.peekRenderTimer !== null) return;
    this.peekRenderTimer = setTimeout(() => {
      this.peekRenderTimer = null;
      this.tui.requestRender();
    }, 300);
    this.peekRenderTimer.unref?.();
  }

  #stopPeeks() {
    if (this.peekRenderTimer !== null) {
      clearTimeout(this.peekRenderTimer);
      this.peekRenderTimer = null;
    }
    for (const peek of this.peeks.values()) peek.stop();
    this.peeks.clear();
  }

  #reconcilePeeks(active) {
    if (!this.peekEnabled) {
      this.#stopPeeks();
      return;
    }
    const desired = (Array.isArray(active) ? active : [])
      .filter((item) => item !== null && item !== undefined && item.id !== undefined)
      .slice(0, 2);
    const wanted = new Set(desired.map((item) => String(item.id)));
    for (const [id, peek] of [...this.peeks]) {
      if (!wanted.has(id)) {
        peek.stop();
        this.peeks.delete(id);
      }
    }
    for (const item of desired) {
      const id = String(item.id);
      const existing = this.peeks.get(id);
      if (existing !== undefined) {
        const label = item.label ?? null;
        if (label !== null && existing.label !== label) {
          existing.label = label;
          this.#schedulePeekRender();
        }
        continue;
      }
      const peek = new PeekSession(this.client, {
        id,
        parentSessionId: item.parentSessionId,
        title: item.title ?? null,
        label: item.label ?? null,
      }, { onUpdate: () => this.#schedulePeekRender() });
      this.peeks.set(id, peek);
      void peek.start();
    }
    this.#schedulePeekRender();
  }

  #renderPeek(width) {
    if (!this.peekEnabled || this.peeks.size === 0) return [];
    const lines = [];
    for (const peek of [...this.peeks.values()].slice(0, 2)) {
      const status = peek.status === 'running'
        ? green('running')
        : peek.status === 'blocked'
          ? yellow('blocked')
          : peek.status === 'error'
            ? red(oneLine(peek.error ?? 'error', 30))
            : faint(peek.status);
      const label = oneLine(peek.displayName, Math.max(12, width - 28));
      lines.push(`${accent('◈')} ${bold(label)} ${status}`);
      const content = peek.lines.slice(-2);
      if (content.length === 0) lines.push(`  ${faint('waiting…')}`);
      for (const line of content) lines.push(`  ${sanitizeText(line)}`);
    }
    return lines.slice(0, 7).map((line) => truncateToWidth(line, width));
  }

  #renderQueue(width) {
    const entries = visibleInboxEntries(this.inbox);
    if (entries.length === 0) return [];
    // Local prompts already have an optimistic row with a `queued` label;
    // avoid showing the same text twice while their inbox event settles.
    const localTexts = new Set(this.echoes.filter((echo) => echo.row?.sub != null).map((echo) => echo.text));
    const shown = entries.filter((entry) => !localTexts.has(textOfContent(entry.message.content)));
    if (shown.length === 0) return [];
    const lines = [truncateToWidth(`${yellow('●')} ${bold('pending messages')}`, width)];
    const max = 3;
    for (const entry of shown.slice(0, max)) {
      const text = oneLine(textOfContent(entry.message.content), 90) || '(empty message)';
      lines.push(truncateToWidth(`  ${accent('›')} ${text} ${faint(`· ${entry.label}`)}`, width));
    }
    if (shown.length > max) lines.push(truncateToWidth(faint(`  … ${shown.length - max} more`), width));
    return lines;
  }

  // ── queue manager ───────────────────────────────────────────────────────

  #clearQueueRemoveArm({ render = true } = {}) {
    if (this.queueRemoveTimer !== null) {
      clearTimeout(this.queueRemoveTimer);
      this.queueRemoveTimer = null;
    }
    this.queueRemoveArmed = null;
    if (this.queueManagerPanel !== null) this.queueManagerPanel.hint = 'enter view · s send now · d remove · r refresh';
    if (render) this.tui.requestRender();
  }

  #refreshQueueManager() {
    if (this.queueManagerHandle === null || this.queueManagerList === null || this.queueManagerPanel === null) return;
    const entries = visibleInboxEntries(this.inbox);
    if (entries.length === 0) {
      this.#note('no queued messages', 'warn');
      this.#closeQueueManager();
      return;
    }
    const selected = this.queueManagerList.getSelectedItem()?.value;
    this.queueManagerList.items = queueItems(entries);
    this.queueManagerList.setFilter(this.queueManagerList.currentQuery);
    if (selected !== undefined) {
      const index = this.queueManagerList.filtered.findIndex((item) => item.value === selected);
      if (index >= 0) this.queueManagerList.selectedIndex = index;
    }
    this.queueManagerPanel.title = `Queued · ${entries.length}`;
    this.tui.requestRender();
  }

  #onInboxChanged() {
    const entries = visibleInboxEntries(this.inbox);
    if (this.queueManagerHandle !== null) this.#refreshQueueManager();
    if (this.queueDetailsHandle !== null && this.queueDetailsId !== null) {
      const exists = entries.some((entry) => entry.message?.id === this.queueDetailsId);
      if (!exists) this.#closeQueueDetails({ returnToQueue: true });
    }
  }

  #onQueueManagerKey(data) {
    if (data === 's' || data === 'S') {
      const entry = this.queueManagerList?.getSelectedItem()?.entry;
      if (entry !== undefined) void this.#steerQueued(entry);
      return true;
    }
    if (data === 'd' || data === 'D') {
      const entry = this.queueManagerList?.getSelectedItem()?.entry;
      if (entry !== undefined) this.#armOrRemoveQueued(entry);
      return true;
    }
    if (data === 'r' || data === 'R') {
      this.#refreshQueueManager();
      return true;
    }
    return false;
  }

  async #showQueueManager() {
    if (this.state.sessionId === null) {
      this.#note('Open a session first; /queue with no text manages pending prompts.', 'warn');
      return;
    }
    this.#hideAutocomplete();
    this.#closeQueueDetails({ showNext: false, focus: false, returnToQueue: false });
    this.#closeQueueManager({ showNext: false, focus: false });
    const entries = visibleInboxEntries(this.inbox);
    if (entries.length === 0) {
      this.#note('no queued messages', 'warn');
      return;
    }
    const list = new FilterList(queueItems(entries), 12, selectTheme);
    const panel = new PickerPanel(`Queued · ${entries.length}`, list, {
      onCancel: () => this.#closeQueueManager(),
      requestRender: () => this.tui.requestRender(),
      hint: 'enter view · s send now · d remove · r refresh',
      onKey: (data) => this.#onQueueManagerKey(data),
    });
    list.onSelect = (item) => {
      if (item?.entry === undefined) return;
      this.#closeQueueManager({ showNext: false, focus: false });
      this.#openQueueDetails(item.entry, { returnToQueue: true });
    };
    this.queueManagerHandle = this.tui.showOverlay(panel, { width: '82%', maxWidth: 110, maxHeight: '72%', anchor: 'center', margin: 1 });
    this.queueManagerPanel = panel;
    this.queueManagerList = list;
    this.tui.requestRender();
  }

  #closeQueueManager({ showNext = true, focus = true } = {}) {
    if (this.queueManagerHandle !== null) this.queueManagerHandle.hide();
    this.queueManagerHandle = null;
    this.queueManagerPanel = null;
    this.queueManagerList = null;
    this.#clearQueueRemoveArm({ render: false });
    if (focus) this.tui.setFocus(this.editor);
    if (showNext) this.#showNextInteractive();
    this.tui.requestRender();
  }

  #openQueueDetails(entry, { returnToQueue = false } = {}) {
    this.#closeQueueManager({ showNext: false, focus: false });
    this.#closeQueueDetails({ showNext: false, focus: false, returnToQueue: false });
    const id = typeof entry?.message?.id === 'string' ? entry.message.id : null;
    this.queueDetailsId = id;
    this.queueDetailsReturnToQueue = returnToQueue === true;
    const panel = new ApprovalDetailsPanel('Queued message', queueSections(entry), {
      onClose: () => this.#closeQueueDetails(),
      requestRender: () => this.tui.requestRender(),
    });
    this.queueDetailsHandle = this.tui.showOverlay(panel, { width: '82%', maxWidth: 110, maxHeight: '82%', anchor: 'center', margin: 1 });
    this.tui.requestRender();
  }

  #closeQueueDetails({ showNext = true, focus = true, returnToQueue = this.queueDetailsReturnToQueue } = {}) {
    if (this.queueDetailsHandle !== null) this.queueDetailsHandle.hide();
    this.queueDetailsHandle = null;
    this.queueDetailsId = null;
    this.queueDetailsReturnToQueue = false;
    if (returnToQueue && showNext && !this.quitting && this.state.connected) {
      this.tui.setFocus(this.editor);
      void this.#showQueueManager();
      this.tui.requestRender();
      return;
    }
    if (focus) this.tui.setFocus(this.editor);
    if (showNext) this.#showNextInteractive();
    this.tui.requestRender();
  }

  #armOrRemoveQueued(entry) {
    const id = typeof entry?.message?.id === 'string' ? entry.message.id : '';
    if (id === '') {
      this.#note('queued message has no id; reopen the queue', 'warn');
      return;
    }
    if (this.queueRemoveArmed?.id === id && Date.now() - this.queueRemoveArmed.at <= 3_000) {
      this.#clearQueueRemoveArm();
      void this.#removeQueued(entry);
      return;
    }
    this.#clearQueueRemoveArm({ render: false });
    this.queueRemoveArmed = { id, at: Date.now() };
    this.queueRemoveTimer = setTimeout(() => {
      this.queueRemoveTimer = null;
      this.#clearQueueRemoveArm();
    }, 3_000);
    this.queueRemoveTimer.unref?.();
    if (this.queueManagerPanel !== null) this.queueManagerPanel.hint = 'press d again to remove · enter view · s send now';
    this.tui.requestRender();
  }

  async #removeQueued(entry) {
    const id = typeof entry?.message?.id === 'string' ? entry.message.id : '';
    if (id === '') return;
    try {
      await this.client.request('queue.update', { itemId: id, action: { kind: 'remove' } });
      this.#note('queued message removed', 'ok');
      this.#refreshQueueManager();
    } catch (error) {
      this.#note(`cannot remove queued message: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async #steerQueued(entry) {
    if (entry?.target !== 'next-turn') {
      this.#note('this message is already steering the current turn', 'warn');
      return;
    }
    if (!this.state.running) {
      this.#note('no turn is running; the message will be delivered next', 'warn');
      return;
    }
    const id = typeof entry?.message?.id === 'string' ? entry.message.id : '';
    if (id === '') return;
    try {
      await this.client.request('queue.update', { itemId: id, action: { kind: 'steer' } });
      this.#note('queued message sent now', 'ok');
      this.#refreshQueueManager();
    } catch (error) {
      this.#note(`cannot send queued message: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  #pendingQueueCount() {
    const texts = new Set(visibleInboxEntries(this.inbox).map((entry) => textOfContent(entry.message.content)));
    for (const echo of this.echoes) {
      const sub = echo.row?.sub;
      if (typeof sub === 'string' && (sub.startsWith('queued') || sub.startsWith('steering'))) {
        texts.add(echo.text);
      }
    }
    return texts.size;
  }

  #renderActivity(width) {
    const state = this.state;
    if (!state.connected) {
      return this.reconnecting || this.reconnectTimer !== null
        ? yellow('reconnecting to Host…')
        : red('Host connection lost');
    }
    const pieces = [];
    const subagentRunning = state.subagents?.running ?? 0;
    if (state.running) {
      pieces.push(`${accent(SPINNER[this.spin])} ${bold('working')}`);
      if (state.turn > 0) pieces.push(faint(`turn ${state.turn}${state.step > 0 ? ` · step ${state.step}` : ''}`));
    } else if (subagentRunning > 0) {
      pieces.push(`${green('●')} ${bold('subagents running')}`);
    } else {
      pieces.push(`${faint('●')} ${faint('ready')}`);
    }
    if (state.interactive === 'approval') pieces.push(yellow('approval pending'));
    else if (state.interactive === 'question') pieces.push(yellow('question pending'));
    const queued = this.#pendingQueueCount();
    if (queued > 0) pieces.push(yellow(`queued ${queued}`));
    const runningJobs = runningJobCount([...this.jobRoster.values()]);
    if (runningJobs > 0) pieces.push(yellow(`jobs ${runningJobs}`));
    if (this.escapePendingAt !== null) pieces.push(yellow('esc again to interrupt'));
    if (this.ctrlCPendingAt !== null) pieces.push(yellow('ctrl+c again to quit'));
    const subagents = state.subagents;
    if (subagents !== undefined && subagents !== null && subagents.total > 0) {
      pieces.push(
        subagents.running > 0
          ? `${green('agents')} ${subagents.running}/${subagents.total}`
          : faint(`agents ${subagents.total} idle`),
      );
    }
    if (Array.isArray(state.todos) && state.todos.length > 0) {
      const done = state.todos.filter((todo) => todo?.status === 'completed').length;
      const active = state.todos.find((todo) => todo?.status === 'in_progress');
      pieces.push(faint(`todo ${done}/${state.todos.length}`) + (active === undefined ? '' : ` ${dim(oneLine(active.content, 40))}`));
    }
    if (state.goal && (state.goal.phase === 'active' || state.goal.phase === 'paused')) {
      pieces.push(purple(`goal ${state.goal.phase}`));
    }
    if (state.plan?.active === true) pieces.push(cyan('plan'));
    if (state.note !== null) pieces.push(faint(state.note));
    return truncateToWidth(pieces.join(faint(' · ')), width);
  }

  #renderFooter(width) {
    const state = this.state;
    const model = state.provider !== null && state.model !== null ? `${state.provider}/${state.model}` : 'no model';
    const window = Number(state.contextWindow);
    const used = Number(state.contextTokens);
    const percent = Number.isFinite(window) && window > 0 && Number.isFinite(used) ? ` ctx ${Math.min(100, Math.round((used / window) * 100))}%` : '';
    const tokens = state.tokens === null ? '' : ` ↑${formatCount(state.tokens.inputTokens)} ↓${formatCount(state.tokens.outputTokens)}`;
    const permission = state.permission === null ? '' : ` ${state.permission}`;
    const subagent = state.subagent ? ` ${yellow('subagent · read-only')}` : '';
    const left = `${faint(sanitizeText(model))}${faint(tokens)}${faint(percent)}${faint(sanitizeText(permission))}${subagent}`;
    const keys = faint('pgup/pgdn history · ctrl+l end · /help');
    return fitLine(left, keys, width);
  }

  // ── transcript ───────────────────────────────────────────────────────────

  #addRow(row, { blankBefore = false } = {}) {
    const add = (component) => {
      const wrapper = new CachedRow(component);
      this.document.addChild(wrapper);
      this.rows.push(component);
      this.rowWrappers.set(component, wrapper);
    };
    if (blankBefore && this.rows.length > 0) add(new BlankRow());
    add(row);
    this.#trimTranscript();
    this.tui.requestRender();
  }

  /**
   * Bound the render set for a very long-running Session. Trimming only while
   * following the end avoids moving a reader's scroll position; older rows stay
   * available until the next append after returning to the bottom.
   */
  #trimTranscript() {
    if (this.rows.length <= MAX_TRANSCRIPT_ROWS) return;
    if (!this.transcript.isFollowingEnd) return;
    const count = this.rows.length - MAX_TRANSCRIPT_ROWS;
    const dropped = this.rows.splice(0, count);
    this.document.children.splice(0, count);
    const droppedSet = new Set(dropped);
    for (const row of dropped) this.rowWrappers.delete(row);
    this.steps.trim(droppedSet);
    this.echoes = this.echoes.filter((echo) => !droppedSet.has(echo.row));
    this.log?.event('transcript-trim', { dropped: count, kept: this.rows.length });
  }

  #removeRow(row) {
    const index = this.rows.indexOf(row);
    if (index >= 0) this.rows.splice(index, 1);
    const wrapper = this.rowWrappers.get(row);
    if (wrapper !== undefined) {
      this.document.removeChild(wrapper);
      this.rowWrappers.delete(row);
    } else {
      this.document.removeChild(row);
    }
    this.tui.requestRender();
  }

  #clearTranscript() {
    this.document.clear();
    this.rows = [];
    this.rowWrappers.clear();
    this.steps.clear();
    this.echoes = [];
    this.inbox = emptyInbox();
    this.jobRoster = new Map();
    this.live = null;
    this.tui.requestRender();
  }

  #note(text, tone = 'dim') {
    this.#addRow(new NoteRow(text, tone));
  }

  #attachLiveReasoning(live) {
    if (live.reasonAttached) return;
    live.reasonRow.setText(live.reasoning);
    live.reasonGroup = this.steps.attachReasoning(live.reasonRow);
    live.reasonAttached = true;
  }

  #removeLiveReasoning(live) {
    if (!live.reasonAttached) return;
    this.steps.removeReasoning(live.reasonRow);
    live.reasonAttached = false;
    live.reasonGroup = null;
  }

  #scheduleLiveRender() {
    if (this.throttle !== null) return;
    this.throttle = setTimeout(() => {
      this.throttle = null;
      if (this.live === null) return;
      this.live.row.setText(this.live.text);
      this.live.reasonRow.setText(this.live.reasoning);
      if (this.live.reasonAttached) this.steps.updateReasoning(this.live.reasonRow);
      this.tui.requestRender();
    }, 60);
  }

  #ensureLive(turn, step) {
    if (this.live !== null) return this.live;
    const reasonRow = new ReasoningRow('', () => this.showReasoning);
    const row = new AssistantRow('', { streaming: true });
    this.#addRow(row);
    this.live = {
      row,
      reasonRow,
      text: '',
      reasoning: '',
      turn,
      step,
      attemptId: undefined,
      reasonAttached: false,
      reasonGroup: null,
    };
    return this.live;
  }

  #appendChunk(chunk) {
    if (chunk === null || typeof chunk !== 'object') return;
    if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return;
    const text = typeof chunk.text === 'string' ? chunk.text : '';
    if (text === '') return;
    const live = this.#ensureLive(this.state.turn, this.state.step);
    if (chunk.type === 'text-delta') {
      live.text += text;
    } else {
      live.reasoning += text;
      this.#attachLiveReasoning(live);
    }
    this.#scheduleLiveRender();
  }

  #replayAttempt(attempt) {
    if (attempt === null || typeof attempt !== 'object') return;
    const live = this.#ensureLive(attempt.turn, attempt.step);
    live.attemptId = attempt.attemptId;
    live.text = '';
    live.reasoning = '';
    const stream = Array.isArray(attempt.stream) ? attempt.stream : [];
    for (const record of stream) {
      if (record === null || typeof record !== 'object') continue;
      if (record.type === 'chunk') this.#appendChunk(record.chunk);
      else if (record.type === 'text-chunks' && Array.isArray(record.texts)) {
        for (const text of record.texts) this.#appendChunk({ type: 'text-delta', text });
      } else if (record.type === 'reasoning-chunks' && Array.isArray(record.texts)) {
        for (const text of record.texts) this.#appendChunk({ type: 'reasoning-delta', text });
      }
    }
  }

  #finalizeAssistant(event) {
    const data = event?.data ?? {};
    const { text, reasoning } = partsOfMessage(data.message);
    const usage = data.usage;
    if (usage !== null && typeof usage === 'object') {
      this.state.tokens = {
        inputTokens: Number(usage.inputTokens ?? 0),
        outputTokens: Number(usage.outputTokens ?? 0),
        cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
      };
      this.state.contextTokens = Number(usage.inputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0);
    }
    if (this.live !== null) {
      const live = this.live;
      this.live = null;
      const finalText = text !== '' ? text : live.text;
      const finalReasoning = reasoning !== '' ? reasoning : live.reasoning;
      if (finalReasoning !== '') {
        live.reasoning = finalReasoning;
        if (!live.reasonAttached) this.#attachLiveReasoning(live);
        else live.reasonRow.setText(finalReasoning);
        if (live.reasonAttached) this.steps.updateReasoning(live.reasonRow);
      }
      if (finalText === '' && finalReasoning === '') {
        this.#removeLiveReasoning(live);
        this.#removeRow(live.row);
      } else {
        live.row.setText(finalText);
        live.row.finalize();
      }
    } else if (text !== '' || reasoning !== '') {
      if (reasoning !== '') {
        this.steps.attachReasoning(new ReasoningRow(reasoning, () => this.showReasoning));
      }
      this.#addRow(new AssistantRow(text, { final: true }));
    }
    if (data.interrupted === true) this.#note('response interrupted', 'warn');
    this.state.step = Number(data.step ?? this.state.step);
    this.tui.requestRender();
  }

  #consumeInboxMessage(message, text) {
    let next = removeInboxMessage(this.inbox, message);
    // The id is authoritative. Only fall back to text when an older Host did
    // not provide one; otherwise a same-text message from history could
    // remove a different pending item.
    if (next === this.inbox && typeof message?.id !== 'string') {
      next = removeInboxMessageByText(this.inbox, text, (entry) => textOfContent(entry.content));
    }
    this.inbox = next;
  }

  #onQueueSplice({ removed, inserted }, data) {
    if (inserted.length > 0) {
      const sub = data.target === 'next-step' ? 'steering · next step' : 'queued · next turn';
      for (const message of inserted) {
        const kind = message.source?.kind;
        if (kind !== undefined && kind !== 'user' && kind !== 'user-question-reply') continue;
        const text = textOfContent(message.content);
        const echo = this.echoes.find((entry) => entry.text === text);
        if (echo !== undefined && echo.row !== null && echo.row.sub !== null) echo.row.sub = sub;
      }
    }
    if (data.outcome === 'canceled') {
      for (const message of removed) {
        const kind = message.source?.kind;
        if (kind !== undefined && kind !== 'user' && kind !== 'user-question-reply') continue;
        const text = textOfContent(message.content);
        const index = this.echoes.findIndex((entry) => entry.text === text && entry.row !== null && entry.row.sub !== null);
        if (index < 0) continue;
        const [echo] = this.echoes.splice(index, 1);
        if (echo.row !== null) this.#removeRow(echo.row);
      }
    }
  }

  #onEvent(event, { history = false } = {}) {
    if (event === null || typeof event !== 'object') return;
    const type = event.type;
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
    switch (type) {
      case 'agent/inbox/spliced': {
        const result = applyInboxSplice(this.inbox, data);
        this.inbox = result.inbox;
        if (!history) {
          this.#onQueueSplice(result, data);
          this.#onInboxChanged();
          this.tui.requestRender();
        }
        return;
      }
      case 'job/registered':
      case 'job/settled': {
        this.jobRoster = mergeJobEvent(this.jobRoster, type, data);
        if (history !== true) {
          if (type === 'job/settled') {
            const tone = data.status === 'failed' ? 'error' : data.status === 'killed' ? 'warn' : 'ok';
            const detail = typeof data.detail === 'string' && data.detail !== '' ? ` · ${oneLine(data.detail, 60)}` : '';
            this.#note(`background job ${data.jobId} ${data.status ?? 'settled'}: ${oneLine(`${data.kind ?? 'job'} ${data.label ?? ''}`, 60)}${detail}`, tone);
          }
          if (this.jobsHandle !== null) void this.#refreshJobsPanel();
          if (this.jobOutputHandle !== null && String(this.jobOutputJob?.id) === String(data.jobId)) void this.#pollJobOutput();
          this.tui.requestRender();
        }
        return;
      }
      case 'user/message': {
        // DSH injects runtime context, skill catalogs and time snapshots as
        // user-role messages. They are model context, not conversation: keep
        // them out of the transcript.
        const kind = data.source?.kind;
        if (kind !== undefined && kind !== 'user' && kind !== 'user-question-reply') return;
        const text = textOfContent(data.content);
        if (text.trim() === '') return;
        if (!history) {
          this.#consumeInboxMessage(data, text);
          this.#onInboxChanged();
        }
        const echoIndex = this.echoes.findIndex((echo) => echo.text === text);
        if (echoIndex >= 0) {
          // The local echo already rendered this message; adopt it as the
          // authoritative row instead of removing and re-adding it, which
          // would briefly (or permanently) drop the user's message.
          const [echo] = this.echoes.splice(echoIndex, 1);
          echo.row.sub = null;
          this.tui.requestRender();
          return;
        }
        this.#addRow(new UserRow(text, kind === 'user-question-reply' ? 'question answer' : null), { blankBefore: true });
        return;
      }
      case 'assistant/message':
        this.#finalizeAssistant(event);
        return;
      case 'assistant/attempt':
        this.#note('an assistant attempt ended without committing a message', 'warn');
        return;
      case 'tool/call': {
        if (typeof data.callId !== 'string' || typeof data.name !== 'string') return;
        this.steps.onToolCall(data.callId, data.name, data.arguments, this.state.turn, this.state.step);
        this.state.note = `${data.name}`;
        return;
      }
      case 'tool/result': {
        const message = data.message ?? {};
        const callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
        if (callId === undefined) return;
        const summary = textOfContent(message.content);
        const isError = data.error !== undefined || message.isError === true;
        this.steps.onToolResult(callId, summary, isError);
        this.tui.requestRender();
        this.#scheduleSubagentRefresh();
        return;
      }
      case 'subagent/catalog':
      case 'subagent/descriptor':
        this.#scheduleSubagentRefresh();
        return;
      case 'turn/start':
        this.state.running = true;
        this.state.turn = Number(data.turn ?? this.state.turn);
        this.state.step = 0;
        this.steps.startStep();
        this.state.reason = null;
        this.state.note = null;
        this.tui.requestRender();
        if (history !== true) this.#reportHerdr();
        if (history !== true) this.#scheduleSubagentRefresh();
        return;
      case 'step/start':
        this.state.step = Number(data.step ?? this.state.step);
        this.steps.startStep();
        this.tui.requestRender();
        return;
      case 'step/end':
        this.steps.finish();
        return;
      case 'turn/end':
        this.steps.finish();
        this.state.running = false;
        this.state.reason = typeof data.reason?.kind === 'string' ? data.reason.kind : null;
        this.state.note = this.state.reason === 'error' ? 'turn failed' : null;
        this.#clearEscapeCancel();
        this.tui.requestRender();
        if (history !== true) this.#reportHerdr();
        if (history !== true) this.#scheduleSubagentRefresh();
        return;
      case 'session/title':
        if (typeof data.title === 'string' && data.title.trim() !== '') this.state.title = data.title;
        if (history !== true) this.#reportHerdr();
        this.tui.requestRender();
        return;
      case 'request/context':
        if (typeof data.provider === 'string') this.state.provider = data.provider;
        if (typeof data.model === 'string') this.state.model = data.model;
        if (Number.isFinite(Number(data.contextWindow))) this.state.contextWindow = Number(data.contextWindow);
        this.tui.requestRender();
        return;
      case 'model/selection': {
        const selection = data.selection ?? (typeof data.provider === 'string' && typeof data.model === 'string' ? data : null);
        if (selection !== null) {
          this.state.provider = selection.provider ?? this.state.provider;
          this.state.model = selection.model ?? this.state.model;
        }
        this.tui.requestRender();
        return;
      }
      case 'permission/preset':
        if (typeof data.preset === 'string') this.state.permission = data.preset;
        this.tui.requestRender();
        return;
      case 'sandbox/mode':
        if (typeof data.mode === 'string' && this.state.permission === null) this.state.permission = data.mode;
        return;
      case 'agent-preset/selected':
        if (typeof data.preset === 'string') this.state.preset = data.preset;
        return;
      case 'working-directory/change':
        if (typeof data.cwd === 'string') this.state.cwd = data.cwd;
        else if (typeof data.path === 'string') this.state.cwd = data.path;
        if (this.autocompleteCwd !== this.state.cwd) this.#installAutocomplete();
        this.tui.requestRender();
        return;
      case 'todo/write': {
        const todos = Array.isArray(data.todos) ? data.todos : Array.isArray(data.items) ? data.items : null;
        if (todos !== null) this.state.todos = todos;
        this.tui.requestRender();
        return;
      }
      case 'goal/change': {
        if (data.operation === 'clear') this.state.goal = null;
        else if (data.goal !== null && typeof data.goal === 'object') this.state.goal = data.goal;
        this.tui.requestRender();
        return;
      }
      case 'plan/mode':
        this.state.plan = { active: data.active === true, pending: data.pending === true };
        this.tui.requestRender();
        return;
      case 'llm/retry':
        this.#note(`retrying: ${oneLine(data.reason ?? data.error?.message ?? 'model request failed', 100)}`, 'warn');
        return;
      case 'compaction/start':
        this.#note('compacting context…', 'dim');
        return;
      case 'compaction/end':
        this.#note('context compacted', 'dim');
        return;
      case 'compaction/summary':
        this.#note('context summary written', 'dim');
        return;
      case 'approval/policy':
        return;
      case 'approval/asked':
        this.#note(`approval requested: ${oneLine(data.toolName ?? 'tool', 60)}`, 'warn');
        return;
      case 'approval/decided':
        this.#note(`approval ${data.outcome === 'allowed-once' ? 'allowed once' : String(data.outcome ?? 'closed')}`, data.outcome === 'allowed-once' ? 'ok' : 'warn');
        return;
      default:
        return;
    }
  }

  // ── host stream ──────────────────────────────────────────────────────────

  #onFrame(message) {
    if (message.sessionId !== this.state.sessionId) return;
    const frame = message.frame;
    if (frame === null || typeof frame !== 'object') return;
    if (frame.type === 'snapshot') {
      this.#applySnapshot(frame);
      return;
    }
    if (frame.type === 'event') {
      this.#onEvent(frame.event);
      return;
    }
    if (frame.type === 'assistant-stream') {
      const inner = frame.frame;
      if (inner?.type === 'start') {
        if (this.live !== null && this.live.attemptId !== undefined && this.live.attemptId !== inner.attemptId) {
          // A retry starts a fresh attempt; keep the abandoned attempt's
          // partial rows but do not append the new deltas to them.
          this.live = null;
        }
        const live = this.#ensureLive(inner.turn, inner.step);
        live.attemptId = inner.attemptId;
      } else if (inner?.type === 'chunk') {
        this.#appendChunk(inner.chunk);
      }
    }
  }

  #applySnapshot(frame) {
    const values = frame.projections?.values ?? {};
    this.state.title = typeof values.title === 'string' ? values.title : null;
    this.state.cwd = typeof frame.header?.cwd === 'string' ? frame.header.cwd : typeof values.workingDirectory === 'string' ? values.workingDirectory : this.state.cwd;
    this.state.preset = typeof values.agentPreset === 'string' ? values.agentPreset : this.state.preset;
    this.state.permission = values.permissions?.currentValue ?? this.state.permission;
    const selection = values.modelSelection?.lastUsed ?? values.modelSelection?.next ?? null;
    if (selection !== null) {
      this.state.provider = selection.provider ?? this.state.provider;
      this.state.model = selection.model ?? this.state.model;
    }
    if (values.tokenUsage !== null && typeof values.tokenUsage === 'object') {
      this.state.tokens = {
        inputTokens: Number(values.tokenUsage.uncachedInputTokens ?? 0) + Number(values.tokenUsage.cacheReadTokens ?? 0),
        outputTokens: Number(values.tokenUsage.outputTokens ?? 0),
        cacheReadTokens: Number(values.tokenUsage.cacheReadTokens ?? 0),
      };
      this.state.contextTokens = this.state.tokens.inputTokens;
    }
    if (values.contextPressure !== null && typeof values.contextPressure === 'object') {
      if (Number.isFinite(Number(values.contextPressure.contextWindow))) this.state.contextWindow = Number(values.contextPressure.contextWindow);
      if (Number.isFinite(Number(values.contextPressure.pressureTokens))) this.state.contextTokens = Number(values.contextPressure.pressureTokens);
    }
    if (Array.isArray(values.todos)) this.state.todos = values.todos;
    this.state.goal = values.goal ?? null;
    if (values.plan !== null && typeof values.plan === 'object') this.state.plan = { active: values.plan.active === true, pending: values.plan.pending === true };
    if (this.autocompleteCwd !== this.state.cwd) this.#installAutocomplete();

    this.inbox = emptyInbox();
    this.jobRoster = new Map();
    const records = Array.isArray(frame.records) ? frame.records : [];
    for (const record of records) {
      if (record?.type === 'event') this.#onEvent(record.event, { history: true });
    }
    // The projection snapshot is authoritative over the history splices above.
    this.inbox = normalizeInbox(values.inbox);
    if (frame.assistantStream?.activeAttempt !== undefined) this.#replayAttempt(frame.assistantStream.activeAttempt);
    this.transcript.scrollToEnd();
    this.tui.requestRender();
    this.#reportHerdr();
    this.#scheduleSubagentRefresh();
  }

  #onSessionError(message) {
    if (message.sessionId !== this.state.sessionId) return;
    this.#note(`session stream failed: ${message.error?.message ?? 'unknown error'}`, 'error');
  }

  #onHostClose() {
    if (this.quitting) return;
    const wasConnected = this.state.connected;
    this.log.event('host-close', {
      pane: process.env.HERDR_PANE_ID ?? null,
      workspace: process.env.HERDR_WORKSPACE_ID ?? null,
    });
    this.state.connected = false;
    this.#clearEscapeCancel();
    this.#clearCtrlC();
    clearInterval(this.heartbeat);
    if (wasConnected) this.#note('Host connection lost; reconnecting…', 'warn');
    this.#scheduleReconnect();
    this.tui.requestRender();
  }

  // ── sessions ─────────────────────────────────────────────────────────────

  async #fetchAllSessions({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && this.sessionListCache !== null && now - this.sessionListCache.at < 5_000) {
      return this.sessionListCache.items;
    }
    if (this.sessionListRequest !== null) return this.sessionListRequest;
    const request = this.client.request('session.list')
      .then((value) => {
        const items = value?.items ?? [];
        this.sessionListCache = { at: Date.now(), items };
        return items;
      })
      .finally(() => {
        if (this.sessionListRequest === request) this.sessionListRequest = null;
      });
    this.sessionListRequest = request;
    return request;
  }

  async #fetchSessions() {
    return (await this.#fetchAllSessions()).filter((item) => item.origin !== 'subagent');
  }

  async #fetchWorkspaces({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && this.workspaceCache !== null && now - this.workspaceCache.at < 10_000) {
      return this.workspaceCache.value;
    }
    try {
      const value = await this.client.request('workspace.list');
      const normalized = value ?? { items: [], archivedSessionIds: [], pinnedSessionIds: [] };
      this.workspaceCache = { at: Date.now(), value: normalized };
      return normalized;
    } catch {
      return { items: [], archivedSessionIds: [], pinnedSessionIds: [] };
    }
  }

  async #showSessionPicker() {
    this.#hideAutocomplete();
    const started = performance.now();
    let loading = null;
    const loadingTimer = setTimeout(() => {
      if (this.quitting || this.pickerHandle !== null || this.infoHandle !== null || this.activeInteractive !== null) return;
      loading = this.tui.showOverlay(new LoadingPanel('Sessions', 'Loading sessions…'), {
        width: '46%',
        maxWidth: 64,
        maxHeight: 6,
        anchor: 'center',
        margin: 1,
      });
      this.tui.requestRender();
    }, 120);
    loadingTimer.unref?.();
    let allSessions;
    let workspaces;
    try {
      [allSessions, workspaces] = await Promise.all([
        this.#fetchAllSessions(),
        // Workspace grouping is optional; do not let a slow registry block the
        // picker. The request continues and warms the cache for the next open.
        withTimeout(this.#fetchWorkspaces(), 300, null),
      ]);
    } finally {
      clearTimeout(loadingTimer);
      if (loading !== null) {
        loading.hide();
        if (!this.quitting) this.tui.setFocus(this.editor);
        this.tui.requestRender();
      }
    }
    if (this.quitting) return;
    const workspaceFallback = workspaces === null;
    if (workspaceFallback) workspaces = { items: [], archivedSessionIds: [], pinnedSessionIds: [] };
    this.log.event('session-picker', {
      ms: Number((performance.now() - started).toFixed(1)),
      sessions: allSessions.length,
      workspaceFallback,
    });
    const parentsWithSubagents = new Set(
      allSessions
        .filter((session) => session.origin === 'subagent')
        .map((session) => String(session.parentSessionId ?? ''))
        .filter((parent) => parent !== ''),
    );
    const visible = allSessions.filter(
      (session) =>
        session.origin !== 'subagent' &&
        (session.blank !== true ||
          session.running === true ||
          parentsWithSubagents.has(String(session.sessionId))),
    );
    this.state.sessionCount = visible.length;
    const items = buildSessionTree({
      sessions: visible,
      workspaceView: workspaces,
      allSessions,
      currentCwd: this.state.cwd ?? this.options.cwd ?? process.cwd(),
      currentSessionId: this.state.sessionId === null ? null : String(this.state.sessionId),
    });
    const list = new FilterList(items, Math.min(14, Math.max(3, items.length)), selectTheme);
    // Start as a compact tree: expand only the current/running groups and the
    // group with the most recent session; search expands matching groups.
    const expanded = new Set();
    let latest = null;
    for (const item of items) {
      if (item.kind === 'group' && item.current === true) expanded.add(item.groupKey);
      if (item.kind !== 'session') continue;
      if (item.running || item.value === this.state.sessionId) expanded.add(item.groupKey);
      if (latest === null || item.updatedAt > latest.updatedAt) latest = item;
    }
    if (latest !== null) expanded.add(latest.groupKey);
    for (const item of items) {
      if (item.kind === 'group' && !expanded.has(item.groupKey)) list.collapsedGroups.add(item.groupKey);
    }
    list.setFilter('');
    // Focus the current directory's Workspace by default, not the New-session
    // action. Prefer the currently open Session, then the most recent Session
    // in that Workspace.
    let preferred = items.findIndex((item) => item.kind === 'session' && item.current === true);
    if (preferred < 0) {
      const group = items.findIndex((item) => item.kind === 'group' && item.current === true);
      if (group >= 0) {
        const groupKey = items[group].groupKey;
        preferred = items.findIndex((item) => item.kind === 'session' && item.groupKey === groupKey);
      }
    }
    if (preferred < 0) preferred = items.findIndex((item) => item.kind === 'session');
    if (preferred >= 0) list.setSelectedIndex(preferred);
    const runningSessions = visible.filter((session) => session.running === true).length;
    const panel = new PickerPanel(
      `Sessions · ${visible.length}${runningSessions > 0 ? ` · ${runningSessions} running` : ''}`,
      list,
      {
        onCancel: () => this.#closePicker(),
        requestRender: () => this.tui.requestRender(),
      },
    );
    const container = new PickerContainer(panel);
    list.onSelect = (item) => {
      if (item.kind === 'group') return;
      this.#closePicker({ quitIfEmpty: false });
      if (item.value === '__new__') void this.#createSession();
      else void this.#openSession(item.value);
    };
    list.onCancel = () => this.#closePicker();
    const handle = this.tui.showOverlay(container, { width: '82%', maxWidth: 110, maxHeight: '80%', anchor: 'center', margin: 1 });
    this.pickerHandle = handle;
    this.pickerPanel = panel;
  }

  #herdrError(result) {
    const stderr = typeof result?.stderr === 'string' ? result.stderr.trim() : '';
    return stderr === '' ? 'herdr command failed' : oneLine(stderr, 120);
  }

  #noteHerdrPluginSetup() {
    let root = 'path/to/dsh-tui-attach';
    try {
      root = fileURLToPath(new URL('../../', import.meta.url));
    } catch {
      // Keep the generic hint.
    }
    this.#note(`Herdr plugin dsh-tui-attach is not linked. Run: herdr plugin link --enabled ${shellArg(root)}`, 'warn');
  }

  async #previewRunningSubagents(argument = '') {
    if (this.state.sessionId === null) {
      this.#note('Open a session first; /agents-preview previews its running subagents.', 'warn');
      return;
    }
    const env = process.env;
    if (env.HERDR_ENV !== '1' || typeof env.HERDR_BIN_PATH !== 'string' || typeof env.HERDR_PANE_ID !== 'string') {
      this.#note('/agents-preview needs to run inside a Herdr pane.', 'warn');
      return;
    }
    const requested = Number.parseInt(argument, 10);
    const limit = Math.min(2, Math.max(1, Number.isFinite(requested) ? requested : 2));
    let rows;
    try {
      rows = await this.#fallbackSubagentRows(String(this.state.sessionId), { recursive: true });
    } catch (error) {
      this.#note(`cannot list subagents: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return;
    }
    const running = rows.filter((row) => row.activity === 'running');
    if (running.length === 0) {
      this.#note('no new running subagents to preview', 'warn');
      return;
    }
    const chosen = running.slice(0, limit);
    const width = process.stdout.columns ?? 120;
    const height = process.stdout.rows ?? 40;
    const exitAfter = process.env.DSH_ATTACH_PREVIEW_EXIT_AFTER?.trim() || '0';
    if (!Number.isFinite(Number(exitAfter)) || Number(exitAfter) < 0) {
      this.#note('DSH_ATTACH_PREVIEW_EXIT_AFTER must be a non-negative number of seconds', 'warn');
      return;
    }
    let target = env.HERDR_PANE_ID;
    let direction = width >= Math.max(160, height * 3) ? 'right' : 'down';
    let opened = 0;
    for (const child of chosen) {
      let args;
      try {
        args = buildPreviewPaneArgs({
          targetPane: target,
          direction,
          sessionId: String(child.id),
          parentSessionId: String(child.parentSessionId || this.state.sessionId),
          profile: this.options.profile,
          endpoint: typeof this.options.endpoint === 'string' && this.options.endpoint !== '' ? resolve(this.options.endpoint) : undefined,
          theme: this.options.theme,
          dshHome: process.env.DSH_HOME,
          exitAfterSeconds: exitAfter,
        });
      } catch (error) {
        this.#note(`cannot prepare preview pane: ${error instanceof Error ? error.message : String(error)}`, 'error');
        break;
      }
      const openedPane = spawnSync(env.HERDR_BIN_PATH, args, { encoding: 'utf8', timeout: 5_000 });
      if (openedPane.status !== 0) {
        const error = this.#herdrError(openedPane);
        this.#note(`cannot open preview pane: ${error}`, 'error');
        if (/plugin_not_found|plugin not found|not linked|plugin_disabled/iu.test(error)) this.#noteHerdrPluginSetup();
        break;
      }
      const paneId = parsePreviewPaneId(openedPane.stdout ?? '');
      if (typeof paneId !== 'string' || paneId === '') {
        this.#note('Herdr plugin pane open returned no pane id', 'error');
        break;
      }
      this.previewedChildren.add(String(child.id));
      this.previewPanes.add(paneId);
      opened += 1;
      target = paneId;
      direction = direction === 'right' ? 'down' : 'right';
    }
    if (opened > 0) {
      this.#note(`opened ${opened} subagent preview pane${opened === 1 ? '' : 's'}`, 'ok');
    }
  }

  // ── background jobs ─────────────────────────────────────────────────────

  async #fetchJobs() {
    const sessionId = this.state.sessionId;
    if (sessionId === null) return [];
    const value = await this.client.request('job.list');
    if (this.state.sessionId !== sessionId) return [];
    const jobs = Array.isArray(value?.jobs) ? value.jobs : [];
    this.jobRoster = new Map(jobs.map((job) => [String(job.id), job]));
    return jobs;
  }

  #jobFooter(job) {
    const parts = [`${job?.kind ?? 'job'} · ${job?.status ?? 'unknown'}`];
    if (typeof job?.progress === 'string' && job.progress.trim() !== '') parts.push(oneLine(job.progress, 60));
    else if (typeof job?.detail === 'string' && job.detail.trim() !== '') parts.push(oneLine(job.detail, 60));
    parts.push(`${formatCount(job?.output?.total ?? 0)} B`);
    return parts.join(' · ');
  }

  #jobPanelTitle(jobs) {
    return `Jobs · ${runningJobCount(jobs)}/${jobs.length} running`;
  }

  async #showJobsPanel() {
    const sessionId = this.state.sessionId;
    if (sessionId === null) {
      this.#note('Open a session first; /jobs lists its background jobs.', 'warn');
      return;
    }
    this.#hideAutocomplete();
    this.#closeJobOutput({ showNext: false, focus: false });
    this.#closeJobsPanel({ showNext: false, focus: false });
    let jobs;
    try {
      jobs = await this.#fetchJobs();
    } catch (error) {
      this.#note(`cannot list background jobs: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return;
    }
    if (this.state.sessionId !== sessionId) return;
    if (jobs.length === 0) {
      this.#note('no background jobs', 'warn');
      return;
    }
    const list = new FilterList(jobItems(jobs), 14, selectTheme);
    const panel = new PickerPanel(this.#jobPanelTitle(jobs), list, {
      onCancel: () => this.#closeJobsPanel(),
      requestRender: () => this.tui.requestRender(),
      hint: 'enter output · k stop · r refresh',
      onKey: (data) => this.#onJobsPanelKey(data),
    });
    list.onSelect = (item) => {
      if (item?.job === undefined) return;
      this.#closeJobsPanel({ showNext: false, focus: false });
      void this.#openJobOutput(item.job, { returnToJobs: true });
    };
    const handle = this.tui.showOverlay(panel, { width: '82%', maxWidth: 110, maxHeight: '80%', anchor: 'center', margin: 1 });
    this.jobsHandle = handle;
    this.jobsPanel = panel;
    this.jobsList = list;
    this.jobsTimer = setInterval(() => {
      if (this.jobsHandle !== null) void this.#refreshJobsPanel();
    }, 1_000);
    this.jobsTimer.unref?.();
    this.tui.requestRender();
  }

  #onJobsPanelKey(data) {
    if (data === 'k' || data === 'K') {
      const item = this.jobsList?.getSelectedItem();
      if (item?.job !== undefined) this.#armOrKillJob(item.job);
      return true;
    }
    if (data === 'r' || data === 'R') {
      void this.#refreshJobsPanel();
      return true;
    }
    return false;
  }

  async #refreshJobsPanel() {
    if (!this.state.connected || this.jobsHandle === null || this.jobsRefreshInFlight) return;
    this.jobsRefreshInFlight = true;
    try {
      const jobs = await this.#fetchJobs();
      if (this.jobsHandle === null || this.jobsList === null || this.jobsPanel === null) return;
      if (jobs.length === 0) {
        this.#note('no background jobs', 'warn');
        this.#closeJobsPanel();
        return;
      }
      const selected = this.jobsList.getSelectedItem()?.value;
      this.jobsList.items = jobItems(jobs);
      this.jobsList.setFilter(this.jobsList.currentQuery);
      if (selected !== undefined) {
        const index = this.jobsList.filtered.findIndex((item) => item.value === selected);
        if (index >= 0) this.jobsList.selectedIndex = index;
      }
      this.jobsPanel.title = this.#jobPanelTitle(jobs);
      this.tui.requestRender();
    } catch (error) {
      if (this.jobsHandle !== null) {
        this.#note(`job list refresh failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    } finally {
      this.jobsRefreshInFlight = false;
    }
  }

  #closeJobsPanel({ showNext = true, focus = true } = {}) {
    if (this.jobsHandle !== null) this.jobsHandle.hide();
    this.jobsHandle = null;
    this.jobsPanel = null;
    this.jobsList = null;
    if (this.jobsTimer !== null) {
      clearInterval(this.jobsTimer);
      this.jobsTimer = null;
    }
    this.#clearJobKillArm({ render: false });
    if (focus) this.tui.setFocus(this.editor);
    if (showNext) this.#showNextInteractive();
    this.tui.requestRender();
  }

  async #openJobOutputById(jobId) {
    const sessionId = this.state.sessionId;
    let jobs;
    try {
      jobs = await this.#fetchJobs();
    } catch (error) {
      this.#note(`cannot read background jobs: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return;
    }
    if (this.state.sessionId !== sessionId) return;
    const job = jobs.find((entry) => String(entry.id) === String(jobId));
    if (job === undefined) {
      this.#note(`background job not found: ${jobId}`, 'warn');
      return;
    }
    await this.#openJobOutput(job);
  }

  async #openJobOutput(job, { returnToJobs = false } = {}) {
    if (job === null || typeof job !== 'object') return;
    this.#hideAutocomplete();
    this.#closeJobsPanel({ showNext: false, focus: false });
    this.#closeJobOutput({ showNext: false, focus: false, returnToJobs: false });
    this.jobOutputJob = job;
    this.jobOutputReturnToJobs = returnToJobs === true;
    this.jobOutputFrom = Math.max(0, Number(job.output?.earliest) || 0);
    this.jobOutputLossy = this.jobOutputFrom > 0;
    this.jobOutputText = this.jobOutputLossy ? '[earlier output was dropped]\n' : '';
    const panel = new JobOutputPanel(jobTitle(job), {
      onClose: () => this.#closeJobOutput(),
      onKill: () => this.#armOrKillJob(this.jobOutputJob),
      requestRender: () => this.tui.requestRender(),
    });
    panel.setText(this.jobOutputText);
    panel.setCommand(typeof job.label === 'string' ? job.label : '', job.kind);
    panel.setFooter(this.#jobFooter(job));
    panel.setKillable(jobIsLive(job));
    const handle = this.tui.showOverlay(panel, { width: '86%', maxWidth: 120, maxHeight: '85%', anchor: 'center', margin: 1 });
    this.jobOutputHandle = handle;
    this.jobOutputPanel = panel;
    this.tui.requestRender();
    await this.#pollJobOutput();
    const outputJob = this.jobOutputJob;
    const outputTotal = Number(outputJob?.output?.total) || 0;
    if (this.jobOutputHandle !== null && (jobIsLive(outputJob) || this.jobOutputFrom < outputTotal)) {
      this.jobOutputTimer = setInterval(() => {
        if (this.jobOutputHandle !== null) void this.#pollJobOutput();
      }, 300);
      this.jobOutputTimer.unref?.();
    }
  }

  async #pollJobOutput() {
    if (!this.state.connected || this.jobOutputReading || this.jobOutputHandle === null || this.jobOutputJob === null) return;
    const jobId = String(this.jobOutputJob.id);
    const from = this.jobOutputFrom;
    this.jobOutputReading = true;
    try {
      const value = await this.client.request('job.read', { jobId, from });
      if (this.jobOutputHandle === null || this.jobOutputJob === null || String(this.jobOutputJob.id) !== jobId) return;
      let text = this.jobOutputText;
      if (value?.lossy === true && !this.jobOutputLossy) {
        if (text !== '' && !text.endsWith('\n')) text += '\n';
        text += '[earlier output was dropped]\n';
        this.jobOutputLossy = true;
      }
      for (const chunk of Array.isArray(value?.chunks) ? value.chunks : []) {
        if (chunk?.gapBefore === true) {
          if (text !== '' && !text.endsWith('\n')) text += '\n';
          text += '[output gap]\n';
        }
        if (typeof chunk?.text === 'string') text += chunk.text;
      }
      this.jobOutputText = text;
      const next = Number(value?.next);
      if (Number.isSafeInteger(next) && next >= 0) this.jobOutputFrom = next;
      const job = value?.job ?? this.jobOutputJob;
      if (job !== null && typeof job === 'object') {
        this.jobOutputJob = job;
        this.jobRoster.set(String(job.id), job);
        this.jobOutputPanel?.setTitle(jobTitle(job));
        this.jobOutputPanel?.setCommand(typeof job.label === 'string' ? job.label : '', job.kind);
        this.jobOutputPanel?.setFooter(this.#jobFooter(job));
        this.jobOutputPanel?.setKillable(jobIsLive(job));
      }
      this.jobOutputPanel?.setText(text);
      this.jobOutputPanel?.setKillArmed(this.jobKillArmed?.id === jobId);
      if (!jobIsLive(this.jobOutputJob) && this.jobOutputFrom >= (Number(this.jobOutputJob?.output?.total) || 0)) {
        if (this.jobOutputTimer !== null) {
          clearInterval(this.jobOutputTimer);
          this.jobOutputTimer = null;
        }
      }
      this.tui.requestRender();
    } catch (error) {
      this.jobOutputPanel?.setFooter(`read failed: ${error instanceof Error ? error.message : String(error)}`);
      if (this.jobOutputTimer !== null) {
        clearInterval(this.jobOutputTimer);
        this.jobOutputTimer = null;
      }
    } finally {
      this.jobOutputReading = false;
    }
  }

  #closeJobOutput({ showNext = true, focus = true, returnToJobs = this.jobOutputReturnToJobs } = {}) {
    if (this.jobOutputHandle !== null) this.jobOutputHandle.hide();
    this.jobOutputHandle = null;
    this.jobOutputPanel = null;
    this.jobOutputJob = null;
    this.jobOutputFrom = 0;
    this.jobOutputText = '';
    this.jobOutputLossy = false;
    this.jobOutputReturnToJobs = false;
    if (this.jobOutputTimer !== null) {
      clearInterval(this.jobOutputTimer);
      this.jobOutputTimer = null;
    }
    this.#clearJobKillArm({ render: false });
    if (returnToJobs && showNext && !this.quitting && this.state.connected) {
      this.tui.setFocus(this.editor);
      void this.#showJobsPanel();
      this.tui.requestRender();
      return;
    }
    if (focus) this.tui.setFocus(this.editor);
    if (showNext) this.#showNextInteractive();
    this.tui.requestRender();
  }

  #clearJobKillArm({ render = true } = {}) {
    if (this.jobKillTimer !== null) {
      clearTimeout(this.jobKillTimer);
      this.jobKillTimer = null;
    }
    this.jobKillArmed = null;
    if (this.jobsPanel !== null) this.jobsPanel.hint = 'enter output · k stop · r refresh';
    this.jobOutputPanel?.setKillArmed(false);
    if (render) this.tui.requestRender();
  }

  #armOrKillJob(job) {
    if (job === null || typeof job !== 'object') return;
    const id = String(job.id);
    if (!jobIsLive(job)) {
      this.#note(`background job ${id} already finished`, 'warn');
      return;
    }
    if (this.jobKillArmed?.id === id && Date.now() - this.jobKillArmed.at <= 3_000) {
      this.#clearJobKillArm();
      void this.#killJob(job);
      return;
    }
    this.#clearJobKillArm({ render: false });
    this.jobKillArmed = { id, at: Date.now() };
    this.jobKillTimer = setTimeout(() => {
      this.jobKillTimer = null;
      this.#clearJobKillArm();
    }, 3_000);
    this.jobKillTimer.unref?.();
    if (this.jobsPanel !== null) this.jobsPanel.hint = 'press k again to stop · enter output · r refresh';
    this.jobOutputPanel?.setKillArmed(true);
    this.tui.requestRender();
  }

  async #killJob(job) {
    const id = String(job?.id ?? '');
    if (id === '') return;
    try {
      const value = await this.client.request('job.kill', { jobId: id });
      if (value?.job !== null && typeof value?.job === 'object') this.jobRoster.set(String(value.job.id), value.job);
      this.#note(`background job ${id} ${value?.outcome === 'already-finished' ? 'already finished' : 'stop requested'}`, 'warn');
      if (this.jobsHandle !== null) void this.#refreshJobsPanel();
      if (this.jobOutputHandle !== null && String(this.jobOutputJob?.id) === id) void this.#pollJobOutput();
    } catch (error) {
      this.#note(`cannot stop background job ${id}: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
    this.tui.requestRender();
  }

  async #showSubagentPicker() {
    this.#hideAutocomplete();
    if (this.state.sessionId === null) {
      this.#note('Open a session first; /agents lists subagents under the current session.', 'warn');
      return;
    }
    let allSessions;
    try {
      allSessions = await this.#fetchAllSessions();
    } catch (error) {
      this.#note(`cannot list subagents: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return;
    }
    const byId = new Map(allSessions.map((session) => [String(session.sessionId), session]));
    let rootId = String(this.state.sessionId);
    const seen = new Set();
    while (!seen.has(rootId)) {
      seen.add(rootId);
      const parent = byId.get(rootId)?.parentSessionId;
      if (parent === undefined || parent === null || !byId.has(String(parent))) break;
      rootId = String(parent);
    }
    const root = byId.get(rootId);
    const childrenByParent = new Map();
    for (const session of allSessions) {
      if (session.origin !== 'subagent') continue;
      const parent = String(session.parentSessionId ?? '');
      if (parent === '') continue;
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
      childrenByParent.get(parent).push(session);
    }
    for (const children of childrenByParent.values()) {
      children.sort((left, right) => {
        if ((left.running === true) !== (right.running === true)) return left.running === true ? -1 : 1;
        return (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0);
      });
    }
    // session.list already carries lineage, running state and titles. Prefer it
    // over the catalog route, which can stall while this Session is followed.
    const hostRows = null;
    const items = [];
    if (hostRows !== null) {
      const updatedAt = (row) => Number(byId.get(String(row.id))?.updatedAt) || 0;
      for (const { row, depth } of orderSubagentRows(hostRows, updatedAt, rootId)) {
        const id = String(row.id);
        const session = byId.get(id);
        const running = row.activity === 'running';
        const current = id === String(this.state.sessionId);
        const label = oneLine(
          sanitizeText(
            typeof row.label === 'string' && row.label.trim() !== ''
              ? row.label
              : session === undefined
                ? id.slice(0, 12)
                : sessionLabel(session),
          ),
        );
        items.push({
          value: id,
          parentSessionId: String(row.parentId ?? ''),
          running,
          label: `${'  '.repeat(depth)}${running ? '●' : '○'} ↳ ${label}${current ? ' · current' : ''}`,
          description: `${row.mode ?? 'unknown'} · ${running ? 'running' : 'idle'}${session === undefined ? '' : ` · ${formatAge(session.updatedAt)} ago`}`,
        });
      }
    } else {
      const visited = new Set();
      const walk = (parentId, depth) => {
      for (const child of childrenByParent.get(parentId) ?? []) {
        const id = String(child.sessionId);
        if (visited.has(id)) continue;
        visited.add(id);
        const title = sessionLabel(child);
        const current = id === String(this.state.sessionId);
        const running = child.running === true;
        items.push({
          value: id,
          parentSessionId: String(child.parentSessionId ?? ''),
          running,
          label: `${'  '.repeat(depth)}${running ? '●' : '○'} ↳ ${title}${current ? ' · current' : ''}`,
          description: `${depth === 0 ? 'direct' : 'nested'} · ${running ? 'running' : 'idle'} · ${formatAge(child.updatedAt)} ago`,
        });
        walk(id, depth + 1);
      }
      };
      walk(rootId, 0);
    }
    if (items.length === 0) {
      this.#note(`no subagents under ${sessionLabel(root ?? { sessionId: rootId })}`, 'warn');
      return;
    }
    const list = new FilterList(items, 14, selectTheme);
    const runningCount = items.filter((item) => item.running === true).length;
    const panel = new PickerPanel(`Subagents · ${items.length}${runningCount > 0 ? ` · ${runningCount} running` : ''}`, list, {
      onCancel: () => this.#closePicker(),
      requestRender: () => this.tui.requestRender(),
    });
    const container = new PickerContainer(panel);
    list.onSelect = (item) => {
      this.#closePicker({ quitIfEmpty: false });
      void this.#openSession(item.value, { parentSessionId: item.parentSessionId });
    };
    list.onCancel = () => this.#closePicker();
    const handle = this.tui.showOverlay(container, { width: '82%', maxWidth: 110, maxHeight: '80%', anchor: 'center', margin: 1 });
    this.pickerHandle = handle;
    this.pickerPanel = panel;
  }

  #closePicker({ quitIfEmpty = true } = {}) {
    this.pickerHandle?.hide();
    this.pickerHandle = null;
    this.tui.setFocus(this.editor);
    this.#showNextInteractive();
    if (quitIfEmpty && this.state.sessionId === null) {
      // Never turn a stray Escape (or a focus-related byte) into a process
      // exit. The initial picker can be reopened with /sessions; ctrl+c is the
      // explicit way out.
      this.#note('No session is open. Use /sessions to pick one, or ctrl+c to exit.', 'warn');
    }
  }

  async #openSession(sessionId, { parentSessionId, quiet = false } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    let subagentInfo = null;
    try {
      subagentInfo = (await this.#fetchAllSessions()).find((session) => String(session.sessionId) === String(sessionId)) ?? null;
    } catch {
      // Listing is only needed to label a subagent view.
    }
    const parent = parentSessionId ?? (subagentInfo?.origin === 'subagent' ? subagentInfo.parentSessionId : null);
    const isSubagent = parent !== null && parent !== undefined && String(parent) !== '';
    this.#stopPeeks();
    this.#clearEscapeCancel();
    this.#clearCtrlC();
    this.#closeQueueDetails({ showNext: false, focus: false, returnToQueue: false });
    this.#closeQueueManager({ showNext: false, focus: false });
    this.#closeJobsPanel({ showNext: false, focus: false });
    this.#closeJobOutput({ showNext: false, focus: false });
    if (isSubagent && this.client.host?.capabilities?.includes('session.open.subagent') !== true) {
      this.#note('Subagent history needs the App restart that loads Host 0.10.0; the subagent list itself is available now.', 'warn');
      return;
    }
    this.#clearInteractions();
    try {
      await this.client.request('session.close').catch(() => {});
    } catch {
      // no session was open
    }
    this.#clearTranscript();
    this.hostCommands = [];
    this.subagentLabels.clear();
    this.state = {
      ...this.state,
      sessionId,
      title: null,
      running: false,
      turn: 0,
      step: 0,
      reason: null,
      tokens: null,
      todos: [],
      goal: null,
      plan: null,
      note: null,
      subagent: isSubagent,
      parentSessionId: isSubagent ? String(parent) : null,
      subagents: { total: 0, running: 0, items: [] },
    };
    this.#installAutocomplete();
    try {
      await this.client.request('session.open', {
        sessionId,
        ...(isSubagent ? { parentSessionId: String(parent), mode: 'unknown' } : {}),
      });
      await this.client.activity();
      this.log.event('session-open', { sessionId, subagent: isSubagent });
      void this.#refreshSubagents();
      this.#warnHostVersion();
      void this.#refreshHostCommands();
    } catch (error) {
      if (!quiet) this.#note(`cannot open session: ${error instanceof Error ? error.message : String(error)}`, 'error');
      this.state.sessionId = null;
      throw error;
    }
    this.tui.requestRender();
  }

  async #createSession() {
    try {
      const value = await this.client.request('session.create', { cwd: this.options.cwd ?? process.cwd() });
      this.sessionListCache = null;
      this.workspaceCache = null;
      await this.#openSession(value.sessionId);
      this.#note(`new session ${value.sessionId.slice(0, 12)}`, 'ok');
    } catch (error) {
      this.#note(`cannot create session: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  // ── prompts and commands ─────────────────────────────────────────────────

  async #onSubmit(text) {
    const value = String(text ?? '').trim();
    if (value === '') return;
    this.editor.addToHistory(value);
    if (value.startsWith('/')) {
      await this.#command(value);
      this.#syncAutocomplete();
      return;
    }
    await this.#submitPrompt(value, 'queue');
    this.#syncAutocomplete();
  }

  async #submitPrompt(text, mode) {
    if (this.state.subagent) {
      this.#note('Subagent conversations are read-only here. Use /parent to go back, or continue it in the Web UI.', 'warn');
      return;
    }
    if (this.state.sessionId === null) {
      this.#note('No session is open. Use /sessions to pick one.', 'warn');
      return;
    }
    const pending = this.state.running;
    const sub = mode === 'steer'
      ? pending ? 'steering · next step' : 'steering…'
      : pending ? 'queued · next turn' : 'sending…';
    const echo = new UserRow(text, sub);
    this.#addRow(echo, { blankBefore: true });
    this.echoes.push({ row: echo, text });
    try {
      await this.client.request('session.prompt', { text, mode });
      this.#reportHerdr('working');
      // Keep the queued/steering label until the Host claims the message and
      // emits user/message. The request resolving only means the inbox
      // accepted it, not that the prompt is now in the conversation.
      await this.client.activity();
    } catch (error) {
      this.#removeRow(echo);
      this.echoes = this.echoes.filter((entry) => entry.row !== echo);
      this.#note(`prompt failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async #command(text) {
    const [rawCommand] = text.split(/\s+/u);
    const command = rawCommand.toLowerCase();
    const restText = text.slice(rawCommand.length).trim();
    switch (command) {
      case '/help':
        this.#openInfo('Help', HELP_LINES);
        return;
      case '/sessions':
        try {
          await this.#showSessionPicker();
        } catch (error) {
          this.#note(`cannot load sessions: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
        return;
      case '/agents':
        await this.#showSubagentPicker();
        return;
      case '/jobs':
        await this.#showJobsPanel();
        return;
      case '/job-output':
        if (restText === '') {
          this.#note('usage: /job-output <job-id>', 'warn');
          return;
        }
        await this.#openJobOutputById(restText.trim());
        return;
      case '/job-kill': {
        if (restText === '') {
          this.#note('usage: /job-kill <job-id>', 'warn');
          return;
        }
        try {
          const jobs = await this.#fetchJobs();
          const job = jobs.find((entry) => String(entry.id) === restText.trim());
          if (job === undefined) {
            this.#note(`background job not found: ${restText.trim()}`, 'warn');
            return;
          }
          if (!jobIsLive(job)) {
            this.#note(`background job ${job.id} already finished`, 'warn');
            return;
          }
          await this.#killJob(job);
        } catch (error) {
          this.#note(`cannot stop background job: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
        return;
      }
      case '/agents-preview':
        await this.#previewRunningSubagents(restText);
        return;
      case '/peek':
        this.peekEnabled = !this.peekEnabled;
        if (!this.peekEnabled) this.#stopPeeks();
        this.#note(this.peekEnabled ? 'subagent peek enabled' : 'subagent peek disabled', 'ok');
        if (this.peekEnabled) void this.#refreshSubagents();
        this.tui.requestRender();
        return;
      case '/parent':
        if (this.state.parentSessionId === null || this.state.parentSessionId === '') {
          this.#note('no parent session for this view', 'warn');
          return;
        }
        try {
          await this.#openSession(this.state.parentSessionId);
        } catch {
          // #openSession reports the failure.
        }
        return;
      case '/resume':
        if (restText !== '') {
          try {
            await this.#openSession(restText.trim());
          } catch {
            // #openSession already reported the failure.
          }
          return;
        }
        await this.#showSessionPicker();
        return;
      case '/new': {
        const cwd = restText === '' ? this.options.cwd ?? process.cwd() : restText.replace(/^~(?=\/|$)/u, process.env.HOME ?? '~');
        try {
          const value = await this.client.request('session.create', { cwd });
          this.sessionListCache = null;
          this.workspaceCache = null;
          await this.#openSession(value.sessionId);
          this.#note(`new session ${value.sessionId.slice(0, 12)} in ${cwd}`, 'ok');
        } catch (error) {
          this.#note(`cannot create session: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
        return;
      }
      case '/rename': {
        if (restText === '') {
          this.#note('usage: /rename <title>', 'warn');
          return;
        }
        try {
          await this.client.request('session.rename', { title: restText });
          this.sessionListCache = null;
          this.state.title = restText;
          this.tui.requestRender();
        } catch (error) {
          this.#note(`rename failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
        return;
      }
      case '/cancel':
        await this.#cancelTurn('command');
        return;
      case '/steer':
        if (restText === '') {
          this.#note('usage: /steer <text>', 'warn');
          return;
        }
        await this.#submitPrompt(restText, 'steer');
        return;
      case '/queue':
        if (restText === '') {
          await this.#showQueueManager();
          return;
        }
        await this.#submitPrompt(restText, 'queue');
        return;
      case '/model': {
        if (restText !== '') {
          const [provider, ...modelParts] = restText.split(/\s+/u);
          const model = modelParts.join(' ');
          if (provider === undefined || model === '') {
            this.#note('usage: /model <provider> <model>', 'warn');
            return;
          }
          await this.#selectModel({ provider, model });
          return;
        }
        await this.#showModelPicker();
        return;
      }
      case '/status':
        this.#openInfo('Status', this.#statusLines());
        return;
      case '/quit':
      case '/exit':
        this.quit('command');
        return;
      default:
        // Host-registered commands run inside the Host. If the Host does not
        // know the name (or is an older build without the command routes), the
        // line falls back to a normal prompt.
        if (await this.#executeHostCommand(text)) return;
        await this.#submitPrompt(text, 'queue');
    }
  }

  /** Execute one non-local slash command through the Host command registry. */
  async #executeHostCommand(line) {
    try {
      const value = await this.client.request('commands.execute', { line });
      if (value?.executed !== true) return false;
      const result = value.result ?? {};
      const text = typeof result.text === 'string' ? result.text.trim() : '';
      this.#note(text !== '' ? text : `${line.split(/\s+/u)[0]} ok`, result.kind === 'error' ? 'error' : 'ok');
      return true;
    } catch (error) {
      if (error?.code === 'attach/unknown-method') return false;
      this.#note(`command failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return true;
    }
  }

  async #showModelPicker() {
    this.#hideAutocomplete();
    try {
      const catalog = await this.client.request('model.catalog');
      const items = [];
      for (const group of catalog.groups ?? []) {
        for (const model of group.models ?? []) {
          const efforts = model.reasoning?.efforts ?? [];
          items.push({
            value: JSON.stringify({ provider: group.id, model: model.id, reasoningEffort: model.reasoning?.defaultEffort }),
            label: `${group.id}/${model.id}`,
            description: `${model.name}${efforts.length === 0 ? '' : ` · effort ${efforts.join('/')}`}`,
          });
        }
      }
      if (items.length === 0) {
        this.#note('no routable model is available', 'warn');
        return;
      }
      const list = new FilterList(items, Math.min(14, items.length), selectTheme);
      const panel = new PickerPanel('Select model', list, {
        onCancel: () => this.#closePicker(),
        requestRender: () => this.tui.requestRender(),
      });
      const container = new PickerContainer(panel);
      list.onSelect = (item) => {
        this.#closePicker();
        void this.#selectModel(JSON.parse(item.value));
      };
      list.onCancel = () => this.#closePicker();
      this.pickerHandle = this.tui.showOverlay(container, { width: '82%', maxWidth: 110, maxHeight: '80%', anchor: 'center', margin: 1 });
      this.pickerPanel = panel;
    } catch (error) {
      this.#note(`cannot list models: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async #selectModel(selection) {
    try {
      const value = await this.client.request('session.selectModel', selection);
      const selected = value?.selected ?? selection;
      this.state.provider = selected.provider;
      this.state.model = selected.model;
      this.#note(`model switched to ${selected.provider}/${selected.model}`, 'ok');
      this.tui.requestRender();
    } catch (error) {
      this.#note(`model switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  #statusLines() {
    const state = this.state;
    const window = Number(state.contextWindow);
    const used = Number(state.contextTokens);
    const percent = Number.isFinite(window) && window > 0 ? `${Math.round((used / window) * 100)}%` : '—';
    const todos = Array.isArray(state.todos) ? state.todos : [];
    const lines = [
      `session   ${state.sessionId ?? '—'}`,
      `title     ${state.title ?? '—'}`,
      `cwd       ${state.cwd ?? '—'}`,
      `model     ${state.provider ?? '—'}/${state.model ?? '—'}`,
      `preset    ${state.preset ?? '—'}`,
      `sandbox   ${state.permission ?? '—'}`,
      `context   ${formatCount(used)} / ${formatCount(window)} (${percent})`,
      `tokens    ↑${formatCount(state.tokens?.inputTokens)} ↓${formatCount(state.tokens?.outputTokens)} cache ${formatCount(state.tokens?.cacheReadTokens)}`,
      `todos     ${todos.filter((todo) => todo.status === 'completed').length}/${todos.length}`,
      `queued    ${this.#pendingQueueCount()}`,
      `jobs      ${runningJobCount([...this.jobRoster.values()])} running / ${this.jobRoster.size} total`,
      `goal      ${state.goal === null ? '—' : `${state.goal.phase} · ${oneLine(state.goal.objective, 60)}`}`,
      `host      pid ${this.client.host?.pid ?? '—'} · ${this.client.host?.profile ?? '—'} · plugin ${this.client.host?.pluginVersion ?? '—'} · protocol ${this.client.host?.protocol ?? '—'}`,
      ...(this.state.subagent
        ? [`subagent  read-only · parent ${this.state.parentSessionId?.slice(0, 12) ?? '—'}`]
        : []),
      `theme     ${this.theme} (--theme light|dark)`,
      `socket    ${this.client.descriptor?.socketPath ?? '—'}`,
      '',
      `ctrl+t thinking (${this.showReasoning ? 'expanded' : 'collapsed'}) · ctrl+o tools (${this.showTools ? 'expanded' : 'collapsed'}) · ctrl+g commands (${this.showCommandGroups ? 'expanded' : 'auto'})`,
    ];
    return lines;
  }

  #openInfo(title, lines) {
    this.#hideAutocomplete();
    if (this.infoHandle !== null) {
      this.infoHandle.hide();
      this.infoHandle = null;
    }
    const panel = new InfoPanel(title, lines, () => this.#closeInfo());
    this.infoHandle = this.tui.showOverlay(panel, { width: '84%', maxWidth: 120, maxHeight: '85%', anchor: 'center', margin: 1 });
  }

  #closeInfo() {
    this.infoHandle?.hide();
    this.infoHandle = null;
    this.tui.setFocus(this.editor);
    this.#showNextInteractive();
  }

  // ── approvals and questions ──────────────────────────────────────────────

  #enqueueInteractive(message) {
    if (message?.type !== 'approval' && message?.type !== 'question') return;
    if (this.interactiveQueue.some((item) => item.requestId === message.requestId)) return;
    if (this.activeInteractive?.requestId === message.requestId) return;
    this.interactiveQueue.push(message);
    this.state.interactive = message.type;
    // An approval or question is time-sensitive: surface it over whatever
    // informational panel happens to be open.
    if (this.infoHandle !== null) this.#closeInfo();
    if (this.pickerHandle !== null) this.#closePicker({ quitIfEmpty: false });
    this.tui.requestRender();
    this.#showNextInteractive();
  }

  #showNextInteractive() {
    if (this.activeInteractive !== null) return;
    this.#hideApprovalDetails();
    if (this.infoHandle !== null || this.pickerHandle !== null) return;
    const next = this.interactiveQueue.shift();
    if (next === undefined) {
      this.state.interactive = null;
      this.tui.requestRender();
      return;
    }
    this.#hideAutocomplete();
    this.activeInteractive = next;
    this.state.interactive = next.type;
    if (next.type === 'approval') {
      const row = next.callId === undefined ? undefined : this.steps.rowFor(next.callId);
      const detail = row?.preview || row?.args || '';
      const rawDetail = row?.args ?? '';
      let panel;
      panel = new ApprovalPanel(next, detail, (outcome) => this.#answerApproval(next, outcome), {
        rawDetail,
        onDetails: () => this.#openApprovalDetails(next, panel.detailsSections()),
      });
      this.activeInteractive.handle = this.tui.showOverlay(
        panel,
        { width: '78%', maxWidth: 100, maxHeight: 40, anchor: 'center', margin: 1 },
      );
    } else {
      this.activeInteractive.handle = this.tui.showOverlay(
        new QuestionPanel(next, {
          onSubmit: (answer) => this.#answerQuestion(next, answer),
          onCancel: () => this.#answerQuestion(next, null),
          requestRender: () => this.tui.requestRender(),
        }),
        { width: '82%', maxWidth: 110, maxHeight: '82%', anchor: 'center', margin: 1 },
      );
    }
    this.tui.requestRender();
    this.#reportHerdr('blocked');
  }

  #openApprovalDetails(request, sections) {
    this.#hideApprovalDetails();
    const panel = new ApprovalDetailsPanel(
      `Approval · ${sanitizeText(request.toolName ?? 'tool')}`,
      sections,
      {
        onClose: () => this.#closeApprovalDetails(),
        requestRender: () => this.tui.requestRender(),
      },
    );
    const handle = this.tui.showOverlay(panel, {
      width: '86%',
      maxWidth: 120,
      maxHeight: '85%',
      anchor: 'center',
      margin: 1,
    });
    this.approvalDetails = { requestId: request.requestId, handle };
    this.tui.requestRender();
  }

  #closeApprovalDetails() {
    if (this.approvalDetails === null) return;
    this.#hideApprovalDetails();
    if (this.activeInteractive?.handle !== undefined) this.activeInteractive.handle.focus();
    else this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  #hideApprovalDetails() {
    const details = this.approvalDetails;
    if (details === null) return;
    this.approvalDetails = null;
    details.handle?.hide();
  }

  #closeInteractive() {
    this.#hideApprovalDetails();
    const active = this.activeInteractive;
    this.activeInteractive = null;
    active?.handle?.hide();
    this.state.interactive = this.interactiveQueue.length > 0 ? this.interactiveQueue[0].type : null;
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
    this.#reportHerdr();
    setTimeout(() => this.#showNextInteractive(), 20);
  }

  async #answerApproval(message, outcome) {
    this.#closeInteractive();
    try {
      await this.client.request('approval.respond', { requestId: message.requestId, outcome });
    } catch (error) {
      this.#note(`approval failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async #answerQuestion(message, answer) {
    this.#closeInteractive();
    if (answer === null) {
      try {
        await this.client.request('question.cancel', { requestId: message.requestId });
        this.#note('question dismissed; another client or timeout can still answer it', 'warn');
      } catch (error) {
        this.#note(`question dismiss failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
      return;
    }
    try {
      await this.client.request('question.respond', { requestId: message.requestId, answers: answer.answers });
      this.#note(answer.skipped === true ? 'question skipped' : 'question answered', answer.skipped === true ? 'warn' : 'ok');
    } catch (error) {
      this.#note(`question failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  /** Release pending prompts before switching sessions. */
  #clearInteractions() {
    this.#hideApprovalDetails();
    const pending = [...this.interactiveQueue];
    if (this.activeInteractive !== null) {
      pending.push(this.activeInteractive);
      this.activeInteractive.handle?.hide();
    }
    this.interactiveQueue = [];
    this.activeInteractive = null;
    this.state.interactive = null;
    this.tui.setFocus(this.editor);
    for (const message of pending) {
      // Detach this window only; the request may still be answerable from the
      // Web UI or another terminal.
      void this.client.request('interactive.detach', { requestId: message.requestId }).catch(() => {});
    }
    this.tui.requestRender();
  }

  #onInteractiveClosed(message) {
    this.interactiveQueue = this.interactiveQueue.filter((item) => item.requestId !== message.requestId);
    if (this.activeInteractive?.requestId === message.requestId) this.#closeInteractive();
    else {
      this.state.interactive = this.activeInteractive?.type ?? this.interactiveQueue[0]?.type ?? null;
      this.tui.requestRender();
      this.#reportHerdr();
    }
  }
}

const HELP_LINES = [
  `${bold('prompting')}   enter send · /steer <text> interrupt+steer · /queue <text> queue · /queue manage`,
  `${bold('sessions')}    /sessions pick · /new [cwd] create · /resume [id] pick · /rename <title>`,
  `${bold('subagents')}   /agents list · /peek toggle bottom peek · /agents-preview [n] Herdr panes · /parent`,
  `${bold('jobs')}        /jobs list · /job-output <id> · /job-kill <id> · running count in activity`,
  `${bold('turn')}        /cancel or esc esc stop the running turn · esc closes panels`,
  `${bold('approval')}    y allow once · n reject · d details (read-only, scrollable)`,
  `${bold('model')}       /model pick provider/model · /status session details`,
  `${bold('display')}     ctrl+t thinking · ctrl+o tools · ctrl+g commands · pgup/pgdn · ctrl+v/alt+v · ctrl+alt+f/b · ctrl+l end`,
  `${bold('emacs')}       ctrl+n/p move · ctrl+a/e line · ctrl+b/f char · ctrl+k/u/w/y kill/yank`,
  `${bold('history')}     up/ctrl+p previous prompt · down/ctrl+n next prompt (history is per run)`,
  `${bold('args')}        /resume and /model complete their arguments · completions float above the input`,
  `${bold('exit')}        ctrl+c twice or /quit`,
  '',
  `${faint('Unknown slash commands first go through the Host command registry, then fall back to a prompt.')}`,
];
