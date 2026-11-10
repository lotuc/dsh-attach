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
  StepGroupRow,
  ToolRow,
  UserRow,
  oneLine,
  partsOfMessage,
  sanitizeText,
  textOfContent,
} from './transcript.js';
import { ApprovalDetailsPanel, ApprovalPanel, BtwPanel, ConfirmPanel, InfoPanel, JobOutputPanel, LoadingPanel, QuestionPanel, TextPromptPanel } from './panels.js';
import { localCommandItems, mergeHostCommands, skillCommandItems } from './command-catalog.js';
import { ModalHost } from './modals.js';
import { openPicker, setPickerItems } from './picker-session.js';
import { AttachEditor } from './editor.js';
import { mergeActiveSubagentLabels } from './subagent-labels.js';
import { buildPreviewPaneArgs, parsePreviewPaneId } from './herdr-preview.js';
import { applyInboxSplice, emptyInbox, normalizeInbox, removeInboxMessage, removeInboxMessageByText, visibleInboxEntries } from './inbox.js';
import { queueItems, queueSections } from './queue.js';
import { StepActivity } from './step-activity.js';
import { DEFAULT_DETAIL_LEVEL, detailFlags, nextDetailLevel, normalizeDetailLevel } from './detail-level.js';
import { shouldOpenParent } from './parent-shortcut.js';
import { describeToolActivity } from './live-activity.js';
import { TranscriptDocument, TurnFoldRow } from './turn-fold.js';
import { executeLocalCommand, parseLocalCommand } from './local-commands.js';
import { buildSessionList, sessionLabel } from './session-list.js';
import { buildSubagentPicker, buildSubagentPickerFromRows } from './subagent-picker.js';
import {
  subagentControlCapabilities,
  subagentControlErrorText,
  subagentControlHint,
  subagentControlUnavailable,
} from './subagent-control.js';
import { goalActivityLabel, goalHostLine, goalStatus, goalStatusLines, normalizeGoal } from './goal.js';
import { planHostLine, planStatusLines } from './plan.js';
import { ctrlCAction } from './ctrl-c.js';
import { readClipboardImage, readClipboardText } from './clipboard-image.js';
import { INTERRUPTED_RESUME_PROMPT, interruptedResumeRequestId, shouldResumeInterrupted } from './interrupted-resume.js';
import { projectSessionState } from './session-events.js';
import { applySnapshotState } from './session-snapshot.js';
import {
  historyActivityHints,
  historyStatusLine,
  oldestEventSeq,
  orderOlderRecords,
  scrollTargetAfterPrepend,
} from './history-pagination.js';
import { buildTranscriptSearch, firstTranscriptMatch } from './transcript-search.js';
import { modelPickerItems } from './model-picker.js';
import { PERMISSION_PRESETS } from './permission-presets.js';
import { formatClock, formatDuration, shortCwd } from './format.js';
import { fitRight } from './layout.js';
import { autocompleteRow } from './autocomplete-layout.js';
import { HerdrReporter, herdrEnvironment } from './herdr.js';
import { PeekSession } from './peek.js';
import { ClientLog, resolveLogPath } from './log.js';
import { isEscape } from './keys.js';
import { BELL, bellEnabled, shouldRingBell } from './notifications.js';
import { ESCAPE_CANCEL_MS, escapeCancelStep } from './escape-cancel.js';
import { jobIsLive, jobDetailsSections, jobItems, jobTitle, mergeJobEvent, runningJobCount } from './jobs.js';

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
const MAX_TRANSCRIPT_ROWS = 5_000;
// Trim in batches instead of shifting the front of a 5k-row array on every
// append once the cap is reached.
const TRANSCRIPT_TRIM_BATCH = 250;
// Explicit history paging may grow past the live-follow bound. Refuse a new
// page once the loaded window reaches this hard ceiling so a manual walk
// cannot consume unbounded memory.
const MAX_PAGED_TRANSCRIPT_ROWS = 25_000;
// The deferred scroll correction waits for the next layout pass; pi-tui's
// throttled frame can take one 16 ms tick plus scheduling slack.
const HISTORY_SCROLL_DELAY_MS = 24;

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
    this.readClipboardImage = options.readClipboardImage ?? readClipboardImage;
    this.readClipboardText = options.readClipboardText ?? readClipboardText;
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
      goalActivation: null,
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
    this.trimmedRows = 0;
    this.historyHasMore = false;
    // Oldest seq the Host included in the most recent snapshot/page. It is the
    // fallback cursor when no rendered row carries a sequence yet.
    this.historyOldestSeq = null;
    // Smallest seq represented by a currently rendered row. Paging uses this
    // boundary instead of the original snapshot boundary so rows trimmed from
    // the front can be fetched again rather than leaving a silent gap.
    this.historyFirstRenderedSeq = null;
    // Cursor for the next older page. It advances to the oldest record the
    // Host returned even when that record produced no transcript row, and it
    // moves forward to the oldest rendered row when trimming drops the front.
    this.historyNextBeforeSeq = null;
    this.historyLoadedPages = 0;
    this.historyLoading = false;
    this.currentTurnFold = null;
    this.turnFolds = new Map();
    this.turnStartedAt = null;
    this.lastTurnCompletedAt = null;
    this.elapsedTimer = null;
    this.historyScrollTimer = null;
    this.historyGeneration = 0;
    this.rowEventSeqs = new Map();
    this.currentEventSeq = null;
    this.currentEventTime = null;
    this.stagingHistory = false;
    this.steps = new StepActivity({
      addRow: (row) => this.#addRow(row),
      removeRow: (row) => this.#removeRow(row),
      requestRender: () => this.tui.requestRender(),
      isGroupExpanded: () => this.showCommandGroups,
      isToolExpanded: () => this.showTools,
    });
    this.echoes = [];
    this.pendingImages = [];
    this.clipboardPastePending = false;
    this.drafts = new Map();
    this.imagesBySession = new Map();
    this.inbox = emptyInbox();
    this.modals = null;
    this.queueManagerPanel = null;
    this.queueManagerList = null;
    this.queueRemoveArmed = null;
    this.queueRemoveTimer = null;
    this.queueDetailsId = null;
    this.queueDetailsReturnToQueue = false;
    this.live = null;
    this.spin = 0;
    this.detailLevel = normalizeDetailLevel(process.env.DSH_ATTACH_DETAIL, DEFAULT_DETAIL_LEVEL);
    const detail = detailFlags(this.detailLevel);
    this.showReasoning = detail.reasoning;
    this.showTools = detail.tools;
    this.showCommandGroups = detail.steps;
    this.showArchivedSessions = false;
    this.quitting = false;
    this.lastRejectionAt = 0;
    this.activeInteractive = null;
    this.interactiveQueue = [];
    this.btwHistory = [];
    this.btwActive = null;
    this.btwSeq = 0;
    this.exit = Promise.withResolvers();
    this.throttle = null;
    this.escapePendingAt = null;
    this.escapeTimer = null;
    this.ctrlCPendingAt = null;
    this.ctrlCTimer = null;
    this.terminalFocused = true;
    this.jobsPanel = null;
    this.jobsList = null;
    this.jobsTimer = null;
    this.jobsRefreshInFlight = false;
    this.jobRoster = new Map();
    this.jobKillArmed = null;
    this.jobKillTimer = null;
    this.jobOutputPanel = null;
    this.jobOutputJob = null;
    this.jobOutputFrom = 0;
    this.jobOutputText = '';
    this.jobOutputLossy = false;
    this.jobOutputReading = false;
    this.jobOutputReturnToJobs = false;
    this.jobOutputTimer = null;
    this.hostCommands = [];
    this.skills = [];
    this.skillsCwd = null;
    this.skillsLoaded = false;
    this.skillsComplete = true;
    this.skillsRequest = null;
    this.skillsWarningShown = false;
    this.autocomplete = null;
    this.autocompleteCwd = null;
    this.hostCommandWarningShown = false;
    this.hostVersionWarningShown = false;
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    this.resumeAfterReconnect = false;
    this.resumeAttempts = new Set();
    this.subagentPoll = null;
    this.goalPoll = null;
    this.goalRefreshInFlight = false;
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
    this.presetCache = null;
    this.newSessionPreset = typeof options.newSessionPreset === 'string' && options.newSessionPreset !== ''
      ? options.newSessionPreset
      : null;
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

  #overlayOpen() {
    return this.modals?.anyOpen() === true || this.activeInteractive !== null;
  }

  #ringBell() {
    if (!shouldRingBell({ enabled: bellEnabled(), focused: this.terminalFocused })) return;
    try {
      process.stdout.write(BELL);
    } catch {
      // A detached terminal must not break the UI.
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async run() {
    this.#buildTui();
    this.tui.start();
    if (process.env.DSH_ATTACH_NO_MOUSE !== '1' && process.env.DSH_ATTACH_FULL_MOUSE !== '1') {
      // pi-tui requests all-motion mouse tracking (1003). Button-motion (1002)
      // is enough for wheel, click and drag selection, and avoids a flood of
      // motion events in terminals such as Herdr/iTerm2. Re-assert 1002 after
      // disabling 1003: some multiplexers derive their mouse encoder mode from
      // the last tracking-mode toggle, and otherwise keep wheel encoding off.
      process.stdout.write('\x1b[?1003l\x1b[?1002h');
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
    this.elapsedTimer = setInterval(() => {
      if (this.quitting) return;
      let changed = false;
      for (const fold of this.turnFolds.values()) {
        if (fold.running && fold.headerAdded) {
          fold.tick();
          changed = true;
        }
      }
      if (changed) this.tui.requestRender();
    }, 1_000);
    this.elapsedTimer.unref?.();
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
    }, 8_000);
    this.subagentPoll.unref?.();
    this.goalPoll = setInterval(() => {
      if (this.quitting || !this.state.connected || this.state.sessionId === null) return;
      if (this.state.goal?.phase !== 'active') return;
      void this.#refreshGoalActivation();
    }, 5_000);
    this.goalPoll.unref?.();

    this.client.on('frame', (message) => this.#onFrame(message));
    this.client.on('goal', (message) => this.#onGoalActivation(message));
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
          this.log.throttled('focus', 2_000, { state: 'out' }, 'focus');
          this.editor?.setTerminalFocused(false);
          this.tui.requestRender();
        } else if (data === '\x1b[I') {
          this.terminalFocused = true;
          this.log.throttled('focus', 2_000, { state: 'in' }, 'focus');
          this.editor?.setTerminalFocused(true);
          void this.#refreshGoalActivation();
          this.tui.requestRender();
        }
        return viewportInput(data);
      };
    }
    this.document = new TranscriptDocument((wrapper) => wrapper?.row?.hiddenByTurn === true);
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
    this.imagePanel = new StateLine((width) => this.#renderImages(width));
    this.footer = new StateLine((width) => this.#renderFooter(width));
    this.editor = new AttachEditor(this.tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
    this.modals = new ModalHost(this.tui, () => this.editor);
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
      { component: this.imagePanel, basis: 'auto', shrink: 0, maxSize: 2 },
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
        if (!ctrlC && data !== '\x1b[O' && data !== '\x1b[I') this.#clearCtrlC();
      }
      const overlayOpen = this.#overlayOpen();
      if (ctrlC) {
        const action = ctrlCAction({
          running: this.state.running,
          overlay: overlayOpen,
          armedAt: this.ctrlCPendingAt,
        });
        if (action === 'quit') {
          this.#clearCtrlC({ render: true });
          this.quit('ctrl+c');
        } else {
          this.#armCtrlC();
        }
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+shift+v')) {
        void this.#pasteClipboardImage({ textFallback: true });
        return { consume: true };
      }
      if ((matchesKey(data, 'ctrl+v') || matchesKey(data, 'super+v')) && !overlayOpen) {
        // Native image paste: terminals send Ctrl+V (or Cmd+V under the kitty
        // keyboard protocol) as a normal key, so inspect the clipboard before
        // the editor treats it as literal-next. If there is no image, fall back
        // to clipboard text so Windows/macOS-style paste works.
        void this.#pasteClipboardImage({ quiet: true, textFallback: true });
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+g')) {
        this.#cycleDetailLevel();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+l')) {
        this.transcript.scrollToEnd();
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+r')) {
        void this.#loadEarlierHistory();
        return { consume: true };
      }
      if (overlayOpen) {
        this.#clearEscapeCancel();
        return undefined;
      }
      if (shouldOpenParent({
        data,
        subagent: this.state.subagent,
        running: this.state.running,
        editorText: this.editor.getText(),
        overlayOpen,
        autocompleteOpen: this.editor.isShowingAutocomplete() || this.autocompleteHandle !== null,
      })) {
        void this.#openParent();
        return { consume: true };
      }
      if (isEscape(data) && this.state.running) {
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
    clearInterval(this.elapsedTimer);
    clearInterval(this.heartbeat);
    clearInterval(this.subagentPoll);
    clearInterval(this.goalPoll);
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
    this.modals?.closeAll({ focus: false, render: false });
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
      const self = this.#selfSubagentItem();
      if (self === null) {
        this.#note('no subagent session is open', 'warn');
        return;
      }
      if (!this.state.running) {
        this.#note('the subagent is not running', 'warn');
        return;
      }
      this.#beginInterruptSubagent(self);
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

  async #forceReconnect() {
    if (this.quitting) return;
    if (this.reconnecting) {
      this.#note('already reconnecting…', 'warn');
      return;
    }
    this.#clearReconnect();
    this.state.connected = false;
    this.state.note = 'reconnecting…';
    this.tui.requestRender();
    await this.#reconnectOnce();
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
        this.resumeAfterReconnect = !this.state.subagent;
        // Snapshot frames may arrive just after session.open resolves.
        setTimeout(() => { this.resumeAfterReconnect = false; }, 2_000).unref?.();
        try {
          await this.#openSession(sessionId, { parentSessionId, quiet: true });
        } catch (error) {
          this.resumeAfterReconnect = false;
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
    } finally {
      this.reconnecting = false;
      // Schedule from the finally block: #scheduleReconnect deliberately
      // refuses to run while a reconnect is in flight, so scheduling from the
      // catch block would silently stop the retry chain after one failure.
      if (!this.state.connected) this.#scheduleReconnect();
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
    const localItems = localCommandItems(this.client, { sessionId: this.state.sessionId });
    const reserved = new Set([
      ...localItems.map((item) => item.name),
      ...this.hostCommands.map((item) => item?.name).filter((name) => typeof name === 'string'),
    ]);
    const commands = mergeHostCommands(
      [...localItems, ...skillCommandItems(this.skills, reserved)],
      this.hostCommands,
    );
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
    if (this.#overlayOpen()) {
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
    return fitRight(left, right, width);
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
    if (this.queueManagerPanel !== null) this.queueManagerPanel.hint = 'enter view · e edit · s send now · d remove · r refresh';
    if (render) this.tui.requestRender();
  }

  #refreshQueueManager() {
    if (!this.modals?.has('queue') || this.queueManagerList === null || this.queueManagerPanel === null) return;
    const entries = visibleInboxEntries(this.inbox);
    if (entries.length === 0) {
      this.#note('no queued messages', 'warn');
      this.#closeQueueManager();
      return;
    }
    setPickerItems(
      { list: this.queueManagerList, panel: this.queueManagerPanel },
      queueItems(entries),
      `Queued · ${entries.length}`,
    );
    this.tui.requestRender();
  }

  #onInboxChanged() {
    const entries = visibleInboxEntries(this.inbox);
    if (this.modals?.has('queue')) this.#refreshQueueManager();
    if (this.modals?.has('queueDetails') && this.queueDetailsId !== null) {
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
    if (data === 'e' || data === 'E') {
      const entry = this.queueManagerList?.getSelectedItem()?.entry;
      if (entry !== undefined) this.#editQueued(entry);
      return true;
    }
    if (data === 'r' || data === 'R') {
      this.#refreshQueueManager();
      return true;
    }
    return false;
  }

  #editQueued(entry) {
    const id = typeof entry?.message?.id === 'string' ? entry.message.id : '';
    if (id === '') {
      this.#note('queued message has no id; reopen the queue', 'warn');
      return;
    }
    const text = textOfContent(entry.message.content);
    this.#closeQueueManager({ showNext: false, focus: false });
    const panel = new TextPromptPanel('Edit queued message', text, {
      onSubmit: (value) => {
        const next = String(value ?? '').trim();
        if (next === '') {
          this.#note('queued message cannot be empty', 'warn');
          return;
        }
        void this.#saveQueuedEdit(id, next);
      },
      onCancel: () => this.#closeQueueEdit(),
      requestRender: () => this.tui.requestRender(),
    });
    this.modals?.open('queueEdit', panel, {
      width: '82%',
      maxWidth: 110,
      maxHeight: 12,
      anchor: 'center',
      margin: 1,
    });
    this.tui.requestRender();
  }

  #closeQueueEdit({ returnToQueue = true } = {}) {
    this.modals?.close('queueEdit', { focus: false, render: false });
    this.tui.setFocus(this.editor);
    if (returnToQueue && !this.quitting && this.state.connected) {
      void this.#showQueueManager();
    }
    this.tui.requestRender();
  }

  async #saveQueuedEdit(id, text) {
    try {
      await this.client.request('queue.update', { itemId: id, action: { kind: 'edit', text } });
      this.#note('queued message updated', 'ok');
    } catch (error) {
      this.#note(`cannot edit queued message: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.#closeQueueEdit();
    }
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
    const picker = openPicker({
      modals: this.modals,
      tui: this.tui,
      slot: 'queue',
      title: `Queued · ${entries.length}`,
      items: queueItems(entries),
      maxVisible: 12,
      hint: 'enter view · e edit · s send now · d remove · r refresh',
      onKey: (data) => this.#onQueueManagerKey(data),
      onCancel: () => this.#closeQueueManager(),
      options: { width: '82%', maxWidth: 110, maxHeight: '72%', anchor: 'center', margin: 1 },
    });
    picker.list.onSelect = (item) => {
      if (item?.entry === undefined) return;
      this.#closeQueueManager({ showNext: false, focus: false });
      this.#openQueueDetails(item.entry, { returnToQueue: true });
    };
    this.queueManagerPanel = picker.panel;
    this.queueManagerList = picker.list;
    this.tui.requestRender();
  }

  #closeQueueManager({ showNext = true, focus = true } = {}) {
    this.modals?.close('queue', { focus: false, render: false });
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
    this.modals?.open('queueDetails', panel, { width: '82%', maxWidth: 110, maxHeight: '82%', anchor: 'center', margin: 1 });
    this.tui.requestRender();
  }

  #closeQueueDetails({ showNext = true, focus = true, returnToQueue = this.queueDetailsReturnToQueue } = {}) {
    this.modals?.close('queueDetails', { focus: false, render: false });
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
    if (this.queueManagerPanel !== null) this.queueManagerPanel.hint = 'press d again to remove · e edit · enter view · s send now';
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
    const pieces = [...this.#activityPrimaryPieces()];
    const interactive = this.#activityInteractivePiece();
    if (interactive !== null) pieces.push(interactive);
    const queued = this.#pendingQueueCount();
    if (queued > 0) pieces.push(yellow(`queued ${queued}`));
    const runningJobs = runningJobCount([...this.jobRoster.values()]);
    if (runningJobs > 0) pieces.push(yellow(`jobs ${runningJobs}`));
    if (this.escapePendingAt !== null) pieces.push(yellow('esc again to interrupt'));
    if (this.ctrlCPendingAt !== null) pieces.push(yellow('ctrl+c again to quit'));
    const subagentPiece = this.#activitySubagentPiece();
    if (subagentPiece !== null) pieces.push(subagentPiece);
    const todoPiece = this.#activityTodoPiece();
    if (todoPiece !== null) pieces.push(todoPiece);
    const goalPiece = this.#activityGoalPiece();
    if (goalPiece !== null) pieces.push(goalPiece);
    if (state.plan?.active === true) pieces.push(cyan('plan'));
    if (state.running) {
      const startedAt = this.currentTurnFold?.startedAt ?? this.turnStartedAt;
      if (Number.isFinite(startedAt)) {
        pieces.push(faint(`started ${formatClock(startedAt)}`));
        pieces.push(faint(formatDuration(Date.now() - startedAt)));
      }
    } else if (this.lastTurnCompletedAt !== null) {
      pieces.push(faint(`last completed ${formatClock(this.lastTurnCompletedAt)}`));
    }
    const historyHints = historyActivityHints({
      hasMore: this.historyHasMore,
      loading: this.historyLoading,
      trimmedRows: this.trimmedRows,
    });
    if (historyHints.length > 0) pieces.push(faint(historyHints.join(' · ')));
    if (state.note !== null) pieces.push(faint(state.note));
    return truncateToWidth(pieces.join(faint(' · ')), width);
  }

  /** The run-state prefix: working (with turn/step), subagents, or idle. */
  #activityPrimaryPieces() {
    const state = this.state;
    if (state.running) {
      const pieces = [`${accent(SPINNER[this.spin])} ${bold('working')}`];
      if (state.turn > 0) pieces.push(faint(`turn ${state.turn}${state.step > 0 ? ` · step ${state.step}` : ''}`));
      return pieces;
    }
    if ((state.subagents?.running ?? 0) > 0) return [`${green('●')} ${bold('subagents running')}`];
    return [`${faint('●')} ${faint('ready')}`];
  }

  /** Pending approval/question marker, or null when nothing is waiting. */
  #activityInteractivePiece() {
    if (this.state.interactive === 'approval') return yellow('approval pending');
    if (this.state.interactive === 'question') return yellow('question pending');
    return null;
  }

  /** Compact subagent counter for the footer, or null when unused. */
  #activitySubagentPiece() {
    const subagents = this.state.subagents;
    if (subagents === undefined || subagents === null || subagents.total <= 0) return null;
    return subagents.running > 0
      ? `${green('agents')} ${subagents.running}/${subagents.total}`
      : faint(`agents ${subagents.total} idle`);
  }

  /** Todo progress plus the active item, or null when no todos exist. */
  #activityTodoPiece() {
    const todos = Array.isArray(this.state.todos) ? this.state.todos : [];
    if (todos.length === 0) return null;
    const done = todos.filter((todo) => todo?.status === 'completed').length;
    const active = todos.find((todo) => todo?.status === 'in_progress');
    return faint(`todo ${done}/${todos.length}`) + (active === undefined ? '' : ` ${dim(oneLine(active.content, 40))}`);
  }

  /** Goal label coloured by phase/activation, or null without a goal. */
  #activityGoalPiece() {
    const goal = this.state.goal;
    if (goal === null) return null;
    const label = goalActivityLabel(goal, 64, this.state.goalActivation);
    if (label === '') return null;
    const phase = goal.phase;
    return phase === 'blocked' ? red(label) : phase === 'complete' ? green(label) : this.state.goalActivation === 'disarmed' ? faint(label) : purple(label);
  }

  #renderFooter(width) {
    const state = this.state;
    const model = state.provider !== null && state.model !== null ? `${state.provider}/${state.model}` : 'no model';
    const window = Number(state.contextWindow);
    const used = Number(state.contextTokens);
    const percent = Number.isFinite(window) && window > 0 && Number.isFinite(used) ? ` ctx ${Math.min(100, Math.round((used / window) * 100))}%` : '';
    const tokens = state.tokens === null ? '' : ` ↑${formatCount(state.tokens.inputTokens)} ↓${formatCount(state.tokens.outputTokens)}`;
    const permission = state.permission === null ? '' : ` ${state.permission}`;
    const subagent = state.subagent ? ` ${yellow('subagent · history read-only')}` : '';
    const left = `${faint(sanitizeText(model))}${faint(tokens)}${faint(percent)}${faint(sanitizeText(permission))}${subagent}`;
    const keys = faint(state.subagent
      ? 'backspace/alt+left parent · pgup/pgdn scroll · ctrl+r older · ctrl+l end · /help'
      : 'pgup/pgdn scroll · ctrl+r older · ctrl+l end · /help');
    return fitRight(left, keys, width);
  }

  // ── transcript ───────────────────────────────────────────────────────────

  #addRow(row, { blankBefore = false } = {}) {
    const fold = this.#isTurnProcessRow(row) ? this.#ensureCurrentTurnFold() : null;
    const add = (component, seq = null) => {
      const wrapper = new CachedRow(component);
      this.document.addChild(wrapper);
      this.rows.push(component);
      this.rowWrappers.set(component, wrapper);
      if (seq !== null) this.#trackRowEvent(component, seq);
    };
    if (blankBefore && this.rows.length > 0) add(new BlankRow());
    if (fold !== null && !fold.headerAdded) {
      add(fold);
      fold.headerAdded = true;
    }
    add(row, this.currentEventSeq);
    if (fold !== null) {
      fold.processRows.add(row);
      row.turnFold = fold;
      row.hiddenByTurn = fold.collapsed;
    }
    if (!this.stagingHistory) {
      this.#trimTranscript();
      this.tui.requestRender();
    }
  }

  /** Whether a transcript row belongs to the turn's work process. */
  #isTurnProcessRow(row) {
    return row instanceof StepGroupRow || row instanceof ReasoningRow || row instanceof ToolRow;
  }

  /** Create or select the fold for the current turn. */
  #ensureCurrentTurnFold(turn = this.state.turn) {
    const key = Number.isFinite(turn) ? turn : this.state.turn;
    if (this.currentTurnFold !== null && this.currentTurnFold.turn === key) return this.currentTurnFold;
    let fold = this.turnFolds.get(key);
    if (fold === undefined) {
      fold = new TurnFoldRow({
        turn: key,
        startedAt: this.turnStartedAt ?? this.currentEventTime ?? Date.now(),
      });
      if (!detailFlags(this.detailLevel).liveWork) fold.setCollapsed(true);
      this.turnFolds.set(key, fold);
    }
    this.currentTurnFold = fold;
    return fold;
  }

  /** Derive the live process phrase from the currently running tool. */
  #updateTurnActivity() {
    const fold = this.currentTurnFold;
    if (fold === null || !fold.running) return;
    const running = this.steps.group?.rows.find((row) => row instanceof ToolRow && row.status === 'running');
    if (running !== undefined) {
      const activity = describeToolActivity(running.name, running.preview);
      fold.setActivity(activity.kind, activity.detail);
      return;
    }
    if (this.live !== null) {
      fold.setActivity('thinking');
      return;
    }
    fold.setActivity('preparing');
  }

  /** Apply one coherent detail level to every fold and detail toggle. */
  #applyDetailLevel({ render = true } = {}) {
    const flags = detailFlags(this.detailLevel);
    this.showReasoning = flags.reasoning;
    this.showTools = flags.tools;
    this.showCommandGroups = flags.steps;
    for (const fold of this.turnFolds.values()) {
      fold.setCollapsed(fold.running ? !flags.liveWork : !flags.completedWork);
    }
    if (render) this.tui.requestRender();
  }

  /** Set a named detail level; empty input cycles to the next one. */
  #setDetailLevel(value = '', { announce = true } = {}) {
    const next = value.trim() === '' ? nextDetailLevel(this.detailLevel) : normalizeDetailLevel(value, '');
    if (next === '') {
      this.#note('detail must be compact, standard, or verbose', 'warn');
      return false;
    }
    this.detailLevel = next;
    this.#applyDetailLevel();
    if (announce) this.#note(`detail ${next}`, 'dim');
    return true;
  }

  #cycleDetailLevel() {
    this.#setDetailLevel('');
  }

  /** Remember the smallest event seq whose output is represented by `row`. */
  #trackRowEvent(row, seq) {
    if (!Number.isSafeInteger(seq) || seq < 0) return;
    if (!this.rowEventSeqs.has(row)) this.rowEventSeqs.set(row, seq);
    if (this.stagingHistory) return;
    if (this.historyFirstRenderedSeq === null || seq < this.historyFirstRenderedSeq) {
      this.historyFirstRenderedSeq = seq;
    }
  }

  /** Recompute the paging boundary after the oldest rendered row is dropped. */
  #recomputeFirstRenderedSeq() {
    let first = null;
    for (const seq of this.rowEventSeqs.values()) {
      if (first === null || seq < first) first = seq;
    }
    this.historyFirstRenderedSeq = first;
  }

  /**
   * Bound the render set for a very long-running Session. Trimming only while
   * following the end avoids moving a reader's scroll position; older rows stay
   * available until the next append after returning to the bottom.
   */
  #trimTranscript() {
    // Once the reader explicitly pages history in, protect that window: the
    // live-follow 5k bound would otherwise discard the page that was just
    // loaded on the next live event. The paging ceiling is the new bound.
    const limit = this.historyLoadedPages > 0 ? MAX_PAGED_TRANSCRIPT_ROWS : MAX_TRANSCRIPT_ROWS;
    if (this.rows.length <= limit + TRANSCRIPT_TRIM_BATCH) return;
    const following = this.transcript.isFollowingEnd;
    // While scrolled up, preserve the view for a while; a very long-running
    // session still gets a hard bound instead of growing without limit.
    if (!following && this.rows.length <= limit + MAX_TRANSCRIPT_ROWS) return;
    const count = this.rows.length - limit;
    const dropped = this.rows.splice(0, count);
    this.document.children.splice(0, count);
    const droppedSet = new Set(dropped);
    let lostBoundary = false;
    for (const row of dropped) {
      this.rowWrappers.delete(row);
      row.turnFold?.processRows.delete(row);
      const seq = this.rowEventSeqs.get(row);
      if (seq !== undefined) {
        this.rowEventSeqs.delete(row);
        if (seq === this.historyFirstRenderedSeq) lostBoundary = true;
      }
    }
    if (lostBoundary) this.#recomputeFirstRenderedSeq();
    if (lostBoundary) {
      // The dropped rows are no longer on screen, but they are still in the
      // durable log. Move the paging cursor to the new rendered boundary (and
      // mark older history loadable) so Ctrl+R refetches the trimmed span
      // instead of leaving a silent hole above the transcript.
      this.historyNextBeforeSeq = this.historyFirstRenderedSeq;
      this.historyHasMore = true;
    }
    this.steps.trim(droppedSet);
    this.echoes = this.echoes.filter((echo) => !droppedSet.has(echo.row));
    this.trimmedRows += count;
    // At the cap this runs once per newly appended row. A synchronous log
    // write there can stall streaming input on a long Session, so coalesce it.
    this.log?.throttled('transcript-trim', 5_000, { dropped: count, kept: this.rows.length, forced: !following }, 'transcript-trim');
  }

  #removeRow(row) {
    row.turnFold?.processRows.delete(row);
    const index = this.rows.indexOf(row);
    if (index >= 0) this.rows.splice(index, 1);
    const wrapper = this.rowWrappers.get(row);
    if (wrapper !== undefined) {
      this.document.removeChild(wrapper);
      this.rowWrappers.delete(row);
    } else {
      this.document.removeChild(row);
    }
    const seq = this.rowEventSeqs.get(row);
    if (seq !== undefined) {
      this.rowEventSeqs.delete(row);
      if (seq === this.historyFirstRenderedSeq && !this.stagingHistory) this.#recomputeFirstRenderedSeq();
    }
    this.tui.requestRender();
  }

  #clearTranscript() {
    this.document.clear();
    this.rows = [];
    this.rowWrappers.clear();
    this.currentTurnFold = null;
    this.turnFolds.clear();
    this.turnStartedAt = null;
    this.lastTurnCompletedAt = null;
    this.btwHistory = [];
    this.btwActive = null;
    this.btwSeq += 1;
    this.trimmedRows = 0;
    this.historyHasMore = false;
    this.historyOldestSeq = null;
    this.historyFirstRenderedSeq = null;
    this.historyNextBeforeSeq = null;
    this.historyLoadedPages = 0;
    this.historyLoading = false;
    this.historyGeneration += 1;
    this.rowEventSeqs.clear();
    if (this.historyScrollTimer !== null) {
      clearTimeout(this.historyScrollTimer);
      this.historyScrollTimer = null;
    }
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
    this.#updateTurnActivity();
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

  /**
   * Apply one Session event, tagging rows with the event seq so history paging
   * can use the oldest still-rendered event as its cursor.
   */
  #onEvent(event, options = {}) {
    if (event === null || typeof event !== 'object') return;
    const previous = this.currentEventSeq;
    const previousTime = this.currentEventTime;
    this.currentEventSeq = Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : null;
    this.currentEventTime = Number.isFinite(event.time) ? event.time : null;
    try {
      this.#dispatchEvent(event, options);
    } finally {
      this.currentEventSeq = previous;
      this.currentEventTime = previousTime;
    }
  }

  /**
   * Apply one event. Projection-handled events are common to every domain and
   * stay here; everything else is delegated to a focused domain handler so the
   * top-level switch remains a readable routing table.
   */
  #dispatchEvent(event, { history = false } = {}) {
    if (event === null || typeof event !== 'object') return;
    const type = event.type;
    const eventTime = Number.isFinite(event.time) ? event.time : null;
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
    const projected = projectSessionState(this.state, type, data);
    if (this.#applyProjectedEvent(type, projected, history)) return;
    switch (type) {
      case 'agent/inbox/spliced':
        return this.#dispatchInboxEvent(data, history);
      case 'job/registered':
      case 'job/settled':
        return this.#dispatchJobEvent(type, data, history);
      case 'user/message':
        return this.#dispatchUserMessage(data, history);
      case 'assistant/message':
        return this.#finalizeAssistant(event);
      case 'assistant/attempt':
        return this.#note('an assistant attempt ended without committing a message', 'warn');
      case 'tool/call':
      case 'tool/result':
        return this.#dispatchToolEvent(type, data, history);
      case 'subagent/catalog':
      case 'subagent/descriptor':
        if (history !== true) this.#scheduleSubagentRefresh();
        return;
      case 'turn/start':
      case 'step/start':
      case 'step/end':
      case 'turn/end':
        return this.#dispatchTurnEvent(type, data, history, eventTime);
      default:
        return;
    }
  }

  /**
   * Apply the shared projection side effects for events the projector handles.
   * @returns {boolean} whether the event was fully handled
   */
  #applyProjectedEvent(type, projected, history) {
    if (!projected.handled) return false;
    if (projected.note !== undefined) this.#note(projected.note.text, projected.note.tone);
    if (projected.autocomplete === true && !this.stagingHistory && this.autocompleteCwd !== this.state.cwd) {
      this.#installAutocomplete();
    }
    if (projected.herdr === true && history !== true) this.#reportHerdr();
    if (type === 'goal/change' && history !== true) void this.#refreshGoalActivation();
    if (projected.changed) this.tui.requestRender();
    return true;
  }

  /** Update the inbox and local queue echoes from one splice event. */
  #dispatchInboxEvent(data, history) {
    const result = applyInboxSplice(this.inbox, data);
    this.inbox = result.inbox;
    if (!history) {
      this.#onQueueSplice(result, data);
      this.#onInboxChanged();
      this.tui.requestRender();
    }
  }

  /** Track a background job and reflect lifecycle changes in open panels. */
  #dispatchJobEvent(type, data, history) {
    this.jobRoster = mergeJobEvent(this.jobRoster, type, data);
    if (history !== true) {
      if (type === 'job/settled') {
        const tone = data.status === 'failed' ? 'error' : data.status === 'killed' ? 'warn' : 'ok';
        const detail = typeof data.detail === 'string' && data.detail !== '' ? ` · ${oneLine(data.detail, 60)}` : '';
        this.#note(`background job ${data.jobId} ${data.status ?? 'settled'}: ${oneLine(`${data.kind ?? 'job'} ${data.label ?? ''}`, 60)}${detail}`, tone);
      }
      if (this.modals?.has('jobs')) void this.#refreshJobsPanel();
      if (this.modals?.has('jobOutput') && String(this.jobOutputJob?.id) === String(data.jobId)) void this.#pollJobOutput();
      this.tui.requestRender();
    }
  }

  /** Render or adopt a committed user message, ignoring injected context. */
  #dispatchUserMessage(data, history) {
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
  }

  /** Apply tool-call and tool-result events to the step activity tracker. */
  #dispatchToolEvent(type, data, history) {
    if (type === 'tool/call') {
      if (typeof data.callId !== 'string' || typeof data.name !== 'string') return;
      this.#ensureCurrentTurnFold().addTool();
      this.steps.onToolCall(data.callId, data.name, data.arguments, this.state.turn, this.state.step);
      this.state.note = `${data.name}`;
      this.#updateTurnActivity();
      return;
    }
    const message = data.message ?? {};
    const callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
    if (callId === undefined) return;
    const summary = textOfContent(message.content);
    const isError = data.error !== undefined || message.isError === true;
    if (isError) this.#ensureCurrentTurnFold().addFailure();
    this.steps.onToolResult(callId, summary, isError);
    this.#updateTurnActivity();
    if (history !== true) {
      this.tui.requestRender();
      this.#scheduleSubagentRefresh();
    }
  }

  /** Advance turn/step state and emit the matching live-only side effects. */
  #dispatchTurnEvent(type, data, history, eventTime = null) {
    switch (type) {
      case 'turn/start':
        this.state.running = true;
        this.state.turn = Number(data.turn ?? this.state.turn);
        this.state.step = 0;
        this.turnStartedAt = eventTime ?? Date.now();
        this.currentTurnFold = null;
        this.#ensureCurrentTurnFold(this.state.turn).setActivity('thinking');
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
        this.#updateTurnActivity();
        this.tui.requestRender();
        return;
      case 'step/end':
        this.steps.finish();
        return;
      case 'turn/end': {
        const wasRunning = this.state.running;
        this.steps.finish();
        this.state.running = false;
        this.state.reason = typeof data.reason?.kind === 'string' ? data.reason.kind : null;
        this.state.note = this.state.reason === 'error' ? 'turn failed' : null;
        const fold = this.currentTurnFold ?? this.#ensureCurrentTurnFold(this.state.turn);
        fold.finish({ endedAt: eventTime ?? Date.now(), failed: this.state.reason === 'error' });
        fold.setCollapsed(!detailFlags(this.detailLevel).completedWork);
        this.lastTurnCompletedAt = fold.endedAt;
        this.currentTurnFold = null;
        this.turnStartedAt = null;
        if (history !== true) this.#clearEscapeCancel();
        this.tui.requestRender();
        if (history !== true) {
          void this.#refreshGoalActivation();
          this.#reportHerdr();
          this.#scheduleSubagentRefresh();
          if (wasRunning) this.#ringBell();
        }
      }
    }
  }

  // ── host stream ──────────────────────────────────────────────────────────

  /** Whether this Host advertises the older-history read route. */
  #historyPagingSupported() {
    return this.client.host?.capabilities?.includes('history.pagination') === true;
  }

  /**
   * Load one older page and prepend it above the currently rendered window.
   *
   * The cursor is the smallest event seq still represented by a rendered row.
   * Using the rendered boundary (rather than only the original snapshot cut)
   * means rows dropped by transcript trimming can be fetched again instead of
   * leaving an invisible gap.
   */
  async #loadEarlierHistory() {
    if (this.state.sessionId === null) {
      this.#note('no session is open', 'warn');
      return;
    }
    if (this.historyLoading) return;
    if (!this.historyHasMore) {
      this.#note('all earlier history is already loaded', 'dim');
      return;
    }
    if (!this.state.connected) {
      this.#note('cannot load earlier history while disconnected', 'warn');
      return;
    }
    if (!this.#historyPagingSupported()) {
      this.#note('this Host cannot load earlier history; restart DeepSeek Harness with the current dsh-attach plugin', 'warn');
      return;
    }
    if (this.rows.length >= MAX_PAGED_TRANSCRIPT_ROWS) {
      this.#note(`history view limit reached (${MAX_PAGED_TRANSCRIPT_ROWS} rows); reconnect to start a fresh window`, 'warn');
      return;
    }
    const beforeSeq = this.historyNextBeforeSeq ?? this.historyFirstRenderedSeq ?? this.historyOldestSeq;
    if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0) {
      this.historyHasMore = false;
      this.#note('the Host did not report an older-history cursor', 'warn');
      return;
    }
    const sessionId = this.state.sessionId;
    const generation = this.historyGeneration;
    this.historyLoading = true;
    this.tui.requestRender();
    try {
      const page = await this.client.request('history.events', { beforeSeq });
      if (this.state.sessionId !== sessionId || this.historyGeneration !== generation) return;
      this.#applyOlderPage(page, beforeSeq);
    } catch (error) {
      if (this.state.sessionId !== sessionId) return;
      this.#note(`cannot load earlier history: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      if (this.state.sessionId === sessionId) {
        this.historyLoading = false;
        this.tui.requestRender();
      }
    }
  }

  /** Validate one older page, replay it into a staging transcript, prepend it. */
  #applyOlderPage(page, beforeSeq) {
    const ordered = orderOlderRecords(page?.records, beforeSeq);
    if (ordered.ignored > 0) {
      this.log?.event('history-page-ignored', { ignored: ordered.ignored, beforeSeq });
    }
    if (ordered.oldestSeq !== null && (this.historyOldestSeq === null || ordered.oldestSeq < this.historyOldestSeq)) {
      this.historyOldestSeq = ordered.oldestSeq;
    }
    if (ordered.records.length === 0) {
      // A page with no usable cursor cannot make progress; stop instead of
      // retrying the same beforeSeq forever.
      this.historyHasMore = false;
      this.#note('the Host returned no earlier events', 'warn');
      return;
    }
    const added = this.#prependOlderRecords(ordered.records);
    const cursors = [this.historyFirstRenderedSeq, ordered.oldestSeq]
      .filter((seq) => Number.isSafeInteger(seq) && seq >= 0);
    this.historyNextBeforeSeq = cursors.length === 0 ? null : Math.min(...cursors);
    this.historyLoadedPages += 1;
    this.historyHasMore = page?.hasMore === true;
    if (!this.historyHasMore && added.rows > 0) {
      this.#note('reached the beginning of session history', 'dim');
    }
    this.log?.event('history-page', {
      beforeSeq,
      events: ordered.records.length,
      rows: added.rows,
      duplicates: ordered.duplicates,
      hasMore: this.historyHasMore,
    });
  }

  /**
   * Replay records without disturbing live state, then insert their rows above
   * the current transcript while keeping the reader's viewport anchored.
   *
   * The staging pass swaps the row/step/echo/state targets so history's
   * turn/step metadata cannot clobber a live turn. The freshly built wrappers
   * are then moved from the document tail to the front in one splice.
   *
   * @param {object[]} records - chronological records older than the window
   * @returns {{rows: number}}
   */
  #prependOlderRecords(records) {
    const liveRows = this.rows;
    const documentCount = this.document.children.length;
    const liveSteps = this.steps;
    const liveEchoes = this.echoes;
    const live = this.live;
    const liveInbox = this.inbox;
    const liveJobRoster = this.jobRoster;
    const liveState = this.state;
    const liveAutocompleteCwd = this.autocompleteCwd;
    const liveRenderedSeq = this.historyFirstRenderedSeq;
    const liveTurnFolds = this.turnFolds;
    const liveCurrentTurnFold = this.currentTurnFold;
    const liveTurnStartedAt = this.turnStartedAt;
    const liveLastTurnCompletedAt = this.lastTurnCompletedAt;

    this.rows = [];
    this.steps = new StepActivity({
      addRow: (row) => this.#addRow(row),
      removeRow: (row) => this.#removeRow(row),
      requestRender: () => {},
      isGroupExpanded: () => this.showCommandGroups,
      isToolExpanded: () => this.showTools,
    });
    this.echoes = [];
    this.live = null;
    this.inbox = emptyInbox();
    this.jobRoster = new Map();
    this.state = { ...liveState };
    this.turnFolds = new Map();
    this.currentTurnFold = null;
    this.turnStartedAt = null;
    this.stagingHistory = true;
    let stagedRows;
    let stagedWrappers;
    try {
      for (const record of records) {
        if (record?.type === 'event') this.#onEvent(record.event, { history: true });
      }
    } finally {
      stagedRows = this.rows;
      stagedWrappers = this.document.children.slice(documentCount);
      this.document.children.length = documentCount;
      this.stagingHistory = false;
      this.rows = liveRows;
      this.steps = liveSteps;
      this.echoes = liveEchoes;
      this.live = live;
      this.inbox = liveInbox;
      this.jobRoster = liveJobRoster;
      this.state = liveState;
      this.autocompleteCwd = liveAutocompleteCwd;
      this.historyFirstRenderedSeq = liveRenderedSeq;
      const stagedFolds = this.turnFolds;
      this.turnFolds = liveTurnFolds;
      this.currentTurnFold = liveCurrentTurnFold;
      this.turnStartedAt = liveTurnStartedAt;
      this.lastTurnCompletedAt = liveLastTurnCompletedAt;
      for (const [turn, fold] of stagedFolds) {
        if (!this.turnFolds.has(turn)) this.turnFolds.set(turn, fold);
      }
    }
    if (stagedRows.length === 0) return { rows: 0 };

    let stagedFirst = null;
    for (const row of stagedRows) {
      const seq = this.rowEventSeqs.get(row);
      if (seq !== undefined && (stagedFirst === null || seq < stagedFirst)) stagedFirst = seq;
    }
    if (stagedFirst !== null && (liveRenderedSeq === null || stagedFirst < liveRenderedSeq)) {
      this.historyFirstRenderedSeq = stagedFirst;
    }

    const lastStaged = stagedRows[stagedRows.length - 1];
    const firstLive = liveRows[0];
    if (
      liveRows.length > 0
      && !(lastStaged instanceof BlankRow)
      && !(firstLive instanceof BlankRow)
    ) {
      const blank = new BlankRow();
      const wrapper = new CachedRow(blank);
      stagedRows.push(blank);
      stagedWrappers.push(wrapper);
      this.rowWrappers.set(blank, wrapper);
    }

    const wasFollowing = this.transcript?.isFollowingEnd === true;
    const previousScrollTop = this.transcript?.scrollTop ?? 0;
    const width = this.terminal?.columns ?? process.stdout.columns ?? 80;
    const contentWidth = this.transcript?.getContentWidth(width) ?? width;
    const addedHeight = stagedWrappers.reduce(
      (total, wrapper) => total + wrapper.render(contentWidth).length,
      0,
    );

    this.document.children.unshift(...stagedWrappers);
    this.rows.unshift(...stagedRows);

    if (this.transcript !== undefined && this.transcript !== null) {
      if (wasFollowing) {
        // Staying at the live edge is the same visual position after content
        // is added above it; ScrollView re-pins on its next layout pass.
        this.transcript.scrollToEnd();
      } else {
        const target = scrollTargetAfterPrepend(previousScrollTop, addedHeight);
        this.transcript.scrollTo(target, { disableFollow: true });
        // ScrollView clamps against the previous content height until the next
        // render lays out the prepended rows. Re-apply once that layout ran.
        if (this.historyScrollTimer !== null) clearTimeout(this.historyScrollTimer);
        this.historyScrollTimer = setTimeout(() => {
          this.historyScrollTimer = null;
          this.transcript?.scrollTo(target, { disableFollow: true });
          this.tui.requestRender();
        }, HISTORY_SCROLL_DELAY_MS);
        this.historyScrollTimer.unref?.();
      }
    }
    this.tui.requestRender();
    return { rows: stagedRows.length };
  }

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
    const records = Array.isArray(frame.records) ? frame.records : [];
    this.historyHasMore = frame.hasMore === true;
    this.historyOldestSeq = oldestEventSeq(records);
    this.historyNextBeforeSeq = this.historyOldestSeq;
    this.historyLoadedPages = 0;
    this.historyLoading = false;
    this.historyGeneration += 1;
    if (this.historyScrollTimer !== null) {
      clearTimeout(this.historyScrollTimer);
      this.historyScrollTimer = null;
    }
    applySnapshotState(this.state, frame);
    if (this.autocompleteCwd !== this.state.cwd) this.#installAutocomplete();

    this.inbox = emptyInbox();
    this.jobRoster = new Map();
    for (const record of records) {
      if (record?.type === 'event') this.#onEvent(record.event, { history: true });
    }
    // The projection snapshot is authoritative over the history splices above.
    // This matters especially for goal/change: an old active event must not
    // overwrite the snapshot's completed/inactive goal.
    applySnapshotState(this.state, frame);
    if (this.autocompleteCwd !== this.state.cwd) this.#installAutocomplete();
    void this.#refreshSkills();
    this.#refreshTodoPanel();
    this.#applyDetailLevel({ render: false });
    this.inbox = normalizeInbox(values.inbox);
    void this.#refreshGoalActivation();
    if (frame.assistantStream?.activeAttempt !== undefined) this.#replayAttempt(frame.assistantStream.activeAttempt);
    if (this.resumeAfterReconnect) {
      this.resumeAfterReconnect = false;
      const turn = this.state.turn;
      setTimeout(() => { void this.#resumeInterruptedTurn(turn); }, 0).unref?.();
    }
    this.transcript.scrollToEnd();
    this.tui.requestRender();
    this.#reportHerdr();
    this.#scheduleSubagentRefresh();
  }

  #todoPanelLines() {
    const todos = Array.isArray(this.state.todos) ? this.state.todos : [];
    if (todos.length === 0) return ['No todos.'];
    const width = this.terminal?.columns ?? 80;
    const completed = todos.filter((todo) => todo?.status === 'completed').length;
    const inProgress = todos.filter((todo) => todo?.status === 'in_progress').length;
    const lines = [
      `${completed}/${todos.length} completed${inProgress > 0 ? ` · ${inProgress} in progress` : ''}`,
      '',
    ];
    for (const todo of todos) {
      const status = todo?.status;
      const marker = status === 'completed' ? green('✓') : status === 'in_progress' ? yellow('◐') : faint('○');
      lines.push(`${marker} ${oneLine(todo?.content ?? '', Math.max(20, width - 12))}`);
    }
    return lines;
  }

  #showTodos() {
    const todos = Array.isArray(this.state.todos) ? this.state.todos : [];
    if (todos.length === 0) {
      this.#note('no todos', 'dim');
      return;
    }
    this.#openInfo('Todos', this.#todoPanelLines());
  }

  #refreshTodoPanel() {
    if (!this.modals?.has('info')) return;
    const panel = this.modals.get('info')?.component;
    if (panel?.title !== 'Todos' || typeof panel.setLines !== 'function') return;
    panel.setLines(this.#todoPanelLines());
    this.tui.requestRender();
  }

  async #refreshSkills({ force = false } = {}) {
    if (this.client.host?.capabilities?.includes('skills') !== true) {
      this.skills = [];
      this.skillsLoaded = true;
      return;
    }
    if (this.state.sessionId === null) return;
    const cwd = this.state.cwd ?? null;
    if (!force && this.skillsLoaded && this.skillsCwd === cwd) return;
    if (this.skillsRequest !== null) return this.skillsRequest;
    const sessionId = this.state.sessionId;
    const request = this.client.request('skill.list')
      .then((value) => {
        if (this.state.sessionId !== sessionId) return;
        this.skills = value?.supported === false ? [] : (Array.isArray(value?.skills) ? value.skills : []);
        this.skillsComplete = value?.complete !== false;
        this.skillsCwd = cwd;
        this.skillsLoaded = true;
        this.#installAutocomplete();
        this.tui.requestRender();
      })
      .catch((error) => {
        if (this.skillsWarningShown) return;
        this.skillsWarningShown = true;
        this.#note(`skill catalog unavailable: ${error instanceof Error ? error.message : String(error)}`, 'warn');
      })
      .finally(() => {
        if (this.skillsRequest === request) this.skillsRequest = null;
      });
    this.skillsRequest = request;
    return request;
  }

  async #showSkills() {
    if (this.client.host?.capabilities?.includes('skills') !== true) {
      this.#note('this Host does not expose a skill catalog', 'warn');
      return;
    }
    await this.#refreshSkills({ force: true });
    if (this.skills.length === 0) {
      this.#note('no user-invocable skills', 'dim');
      return;
    }
    if (!this.skillsComplete) this.#note('skill discovery is incomplete; showing confirmed skills', 'warn');
    this.#openInfo('Skills', this.skills.map((skill) => {
      const description = typeof skill.description === 'string' ? oneLine(skill.description, 100) : '';
      return `${skill.name}${description === '' ? '' : ` — ${description}`}`;
    }));
  }

  async #showSkill(name) {
    const skillName = String(name ?? '').trim();
    if (skillName === '') return;
    try {
      const value = await this.client.request('skill.get', { name: skillName });
      if (value?.supported !== true || value.skill === null || value.skill === undefined) {
        this.#note(`skill not found: ${skillName}`, 'warn');
        return;
      }
      const skill = value.skill;
      const lines = [
        `provider  ${skill.provider ?? '—'}`,
        ...(typeof skill.path === 'string' && skill.path !== '' ? [`path      ${skill.path}`] : []),
        ...(typeof skill.description === 'string' && skill.description !== '' ? [`summary   ${oneLine(skill.description, 120)}`] : []),
        '',
        ...String(skill.content ?? '').split(/\r?\n/u).slice(0, 2000),
      ];
      this.#openInfo(`Skill ${skillName}`, lines);
    } catch (error) {
      this.#note(`cannot load skill: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async #runSkill(name) {
    const skillName = String(name ?? '').trim();
    if (skillName === '') return;
    if (!this.skills.some((skill) => skill?.name === skillName)) await this.#refreshSkills({ force: true });
    if (!this.skills.some((skill) => skill?.name === skillName)) {
      this.#note(`skill not found: ${skillName}`, 'warn');
      return;
    }
    await this.#submitPrompt(`/${skillName}`, 'queue');
  }

  async #refreshGoalActivation() {
    if (this.state.sessionId === null) return this.state.goal;
    if (this.client.host?.capabilities?.includes('goal.activation') !== true) return this.state.goal;
    if (this.goalRefreshInFlight) return this.state.goal;
    this.goalRefreshInFlight = true;
    const sessionId = this.state.sessionId;
    try {
      const value = await this.client.request('goal.get');
      if (this.state.sessionId !== sessionId || value?.supported !== true) return this.state.goal;
      this.state.goal = normalizeGoal(value.goal);
      this.state.goalActivation = typeof value.goal?.activation === 'string' ? value.goal.activation : null;
      this.tui.requestRender();
    } catch {
      // Goal activation is supplementary; keep the durable snapshot phase.
    } finally {
      this.goalRefreshInFlight = false;
    }
    return this.state.goal;
  }

  #onGoalActivation(message) {
    if (message?.sessionId !== this.state.sessionId) return;
    const goal = message.goal;
    if (goal === null || typeof goal !== 'object') {
      this.state.goalActivation = null;
    } else if (
      this.state.goal !== null
      && String(goal.id) === String(this.state.goal.id)
      && Number(goal.revision) === Number(this.state.goal.revision)
    ) {
      this.state.goalActivation = typeof goal.activation === 'string' ? goal.activation : null;
    } else {
      void this.#refreshGoalActivation();
      return;
    }
    this.tui.requestRender();
    this.#reportHerdr();
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

  async #fetchSessionPresets({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && this.presetCache !== null && now - this.presetCache.at < 30_000) {
      return this.presetCache.value;
    }
    const value = await this.client.request('session.presets');
    const normalized = {
      supported: value?.supported === true,
      presets: Array.isArray(value?.presets) ? value.presets : [],
      defaultId: typeof value?.defaultId === 'string' ? value.defaultId : null,
    };
    this.presetCache = { at: Date.now(), value: normalized };
    return normalized;
  }

  #hasCapability(name) {
    return this.client.host?.capabilities?.includes(name) === true;
  }

  /** Target an explicit session id, or the session currently followed. */
  #sessionTarget(id) {
    const value = typeof id === 'string' ? id.trim() : '';
    if (value !== '') return value;
    return this.state.sessionId === null ? null : String(this.state.sessionId);
  }

  async #showSessionPresets() {
    if (!this.#hasCapability('session.presets')) {
      this.#note('This Host does not expose an agent-preset catalog; new sessions use the Host default.', 'warn');
      return;
    }
    let catalog;
    try {
      catalog = await this.#fetchSessionPresets({ fresh: true });
    } catch (error) {
      this.#note(`cannot load agent presets: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return;
    }
    if (!catalog.supported) {
      this.#note('This Host does not expose an agent-preset catalog; new sessions use the Host default.', 'warn');
      return;
    }
    if (catalog.presets.length === 0) {
      this.#note('The Host advertised no agent presets.', 'warn');
      return;
    }
    const lines = [
      'Agent presets available for new sessions:',
      '',
      ...catalog.presets.map((preset) => {
        const selected = preset.id === this.newSessionPreset ? '*' : ' ';
        const markers = [preset.isDefault === true ? 'default' : '', preset.broken ? 'unavailable' : '']
          .filter(Boolean)
          .join(', ');
        const description = typeof preset.description === 'string'
          ? oneLine(sanitizeText(preset.description), 100)
          : '';
        return `${selected} ${preset.name ?? preset.id} (${preset.id})${markers === '' ? '' : ` · ${markers}`}${description === '' ? '' : `\n   ${description}`}`;
      }),
      '',
      `next session   ${this.newSessionPreset ?? '(Host default)'}`,
      'Use /session preset <id> to choose, or /session new --preset <id>.',
    ];
    this.#openInfo('Agent presets', lines);
  }

  async #showSessionPresetPicker() {
    if (!this.#hasCapability('session.presets')) {
      this.#note('This Host does not expose an agent-preset catalog; new sessions use the Host default.', 'warn');
      return;
    }
    let catalog;
    try {
      catalog = await this.#fetchSessionPresets({ fresh: true });
    } catch (error) {
      this.#note(`cannot load agent presets: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return;
    }
    if (!catalog.supported) {
      this.#note('This Host does not expose an agent-preset catalog; new sessions use the Host default.', 'warn');
      return;
    }
    if (catalog.presets.length === 0) {
      this.#note('The Host advertised no agent presets.', 'warn');
      return;
    }
    this.#hideAutocomplete();
    const items = catalog.presets.map((preset) => ({
      value: preset.id,
      label: `${preset.name ?? preset.id}${preset.isDefault === true ? ' · default' : ''}${preset.broken ? ' · unavailable' : ''}`,
      description: typeof preset.description === 'string' ? sanitizeText(oneLine(preset.description, 100)) : '',
    }));
    const picker = openPicker({
      modals: this.modals,
      tui: this.tui,
      title: 'Preset for new sessions',
      items,
      hint: 'enter choose · esc cancel',
      onCancel: () => this.#closePicker(),
    });
    const selected = items.findIndex((item) => item.value === this.newSessionPreset);
    if (selected >= 0) picker.list.setSelectedIndex(selected);
    picker.list.onSelect = (item) => {
      this.#closePicker({ quitIfEmpty: false });
      void this.#setNewSessionPreset(item.value);
    };
    picker.list.onCancel = () => this.#closePicker();
  }

  async #setNewSessionPreset(id) {
    const value = String(id ?? '').trim();
    if (value === '' || value === 'default' || value === 'off' || value === 'reset') {
      this.newSessionPreset = null;
      this.#note('new sessions will use the Host default agent preset', 'ok');
      this.tui.requestRender();
      return;
    }
    if (this.#hasCapability('session.presets')) {
      try {
        const catalog = await this.#fetchSessionPresets();
        if (catalog.supported
          && catalog.presets.length > 0
          && !catalog.presets.some((preset) => preset.id === value)) {
          this.#note(`unknown agent preset ${value}; run /session presets to list them`, 'warn');
          return;
        }
      } catch {
        // The Host remains authoritative when the roster cannot be read.
      }
    }
    this.newSessionPreset = value;
    this.#note(`new sessions will use agent preset ${value}`, 'ok');
    this.tui.requestRender();
  }

  async #forkSession(id) {
    const target = this.#sessionTarget(id);
    if (target === null) {
      this.#note('No session is open. Use /sessions to pick one.', 'warn');
      return;
    }
    if (!this.#hasCapability('session.fork')) {
      this.#note('This Host does not expose session forking; restart with a newer dsh-attach Host plugin.', 'warn');
      return;
    }
    try {
      const value = await this.client.request('session.fork', { sessionId: target });
      const childId = typeof value?.sessionId === 'string' ? value.sessionId : '';
      if (childId === '') throw new Error('Host returned no fork session id');
      this.sessionListCache = null;
      this.workspaceCache = null;
      await this.#openSession(childId);
      this.#note(`forked ${target.slice(0, 12)} → ${childId.slice(0, 12)}`, 'ok');
    } catch (error) {
      this.#note(`fork failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async #archiveSession(id, { stopActivity = false } = {}) {
    const target = this.#sessionTarget(id);
    if (target === null) {
      this.#note('No session is open. Use /sessions to pick one.', 'warn');
      return;
    }
    if (!this.#hasCapability('session.archive')) {
      this.#note('This Host does not expose session archival; restart with a newer dsh-attach Host plugin.', 'warn');
      return;
    }
    try {
      await this.client.request('session.archive', {
        sessionId: target,
        ...(stopActivity ? { stopActivity: true } : {}),
      });
      this.sessionListCache = null;
      this.workspaceCache = null;
      if (this.state.sessionId === target) {
        this.#note(`archived the open session ${target.slice(0, 12)}; it stays readable and can be unarchived`, 'warn');
      } else {
        this.#note(`archived ${target.slice(0, 12)}`, 'ok');
      }
      this.tui.requestRender();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = !stopActivity && /active/i.test(message)
        ? ' · retry with /session archive --stop to stop its work'
        : '';
      this.#note(`archive failed: ${message}${hint}`, 'error');
    }
  }

  async #unarchiveSession(id) {
    const target = this.#sessionTarget(id);
    if (target === null) {
      this.#note('No session is open. Use /sessions to pick one.', 'warn');
      return;
    }
    if (!this.#hasCapability('session.archive')) {
      this.#note('This Host does not expose session archival; restart with a newer dsh-attach Host plugin.', 'warn');
      return;
    }
    try {
      await this.client.request('session.unarchive', { sessionId: target });
      this.sessionListCache = null;
      this.workspaceCache = null;
      this.#note(`unarchived ${target.slice(0, 12)}`, 'ok');
      this.tui.requestRender();
    } catch (error) {
      this.#note(`unarchive failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async #setSessionPinned(id, pinned) {
    const target = this.#sessionTarget(id);
    if (target === null) {
      this.#note('No session is open. Use /sessions to pick one.', 'warn');
      return;
    }
    if (!this.#hasCapability('session.pin')) {
      this.#note('This Host does not expose session pinning; restart with a newer dsh-attach Host plugin.', 'warn');
      return;
    }
    try {
      await this.client.request(pinned ? 'session.pin' : 'session.unpin', { sessionId: target });
      this.workspaceCache = null;
      this.#note(`${pinned ? 'pinned' : 'unpinned'} ${target.slice(0, 12)}`, 'ok');
      this.tui.requestRender();
    } catch (error) {
      this.#note(`${pinned ? 'pin' : 'unpin'} failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async #deleteSession(id) {
    const target = this.#sessionTarget(id);
    const subject = target === null ? 'Sessions' : `Session ${target.slice(0, 12)}`;
    this.#note(`${subject} cannot be deleted: the DSH Host API exposes archive, not session deletion. Use /session archive to hide it; archived sessions stay recoverable.`, 'warn');
  }

  async #showSessionPicker() {
    this.#hideAutocomplete();
    const started = performance.now();
    let loading = null;
    const loadingTimer = setTimeout(() => {
      if (this.quitting || this.#overlayOpen()) return;
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
    const items = buildSessionList({
      sessions: visible,
      workspaceView: workspaces,
      allSessions,
      currentSessionId: this.state.sessionId === null ? null : String(this.state.sessionId),
      includeArchived: this.showArchivedSessions,
    });
    this.state.sessionCount = items.length;
    // Use a stable terminal-relative width; the table fills it so the right
    // columns stay on the edge instead of leaving an unpainted tail.
    const desiredWidth = Math.min(112, Math.max(72, Math.floor((process.stdout.columns ?? 120) * 0.78)));
    const runningSessions = items.filter((item) => item.running === true).length;
    const picker = openPicker({
      modals: this.modals,
      tui: this.tui,
      title: `Sessions · ${items.length}${runningSessions > 0 ? ` · ${runningSessions} running` : ''}${this.showArchivedSessions ? ' · archived shown' : ''}`,
      items,
      maxVisible: Math.min(14, Math.max(3, items.length)),
      hint: `${this.showArchivedSessions ? 'ctrl+a hide archived' : 'ctrl+a archived'} · n new · f fork · a archive · p pin`,
      preview: (item) => (typeof item?.path === 'string' && item.path !== '' ? `path ${item.path}` : ''),
      onKey: (data) => {
        if (matchesKey(data, 'ctrl+a')) {
          this.showArchivedSessions = !this.showArchivedSessions;
          this.#closePicker({ quitIfEmpty: false });
          void this.#showSessionPicker();
          return true;
        }
        if (data === 'n' || data === 'N') {
          this.#closePicker({ quitIfEmpty: false });
          void this.#createSession();
          return true;
        }
        const selected = picker.list.getSelectedItem();
        if (selected?.kind !== 'session') return false;
        const target = String(selected.value);
        if (data === 'f' || data === 'F') {
          this.#closePicker({ quitIfEmpty: false });
          void this.#forkSession(target);
          return true;
        }
        if (data === 'a' || data === 'A') {
          this.#closePicker({ quitIfEmpty: false });
          if (selected.archived === true) void this.#unarchiveSession(target);
          else void this.#archiveSession(target);
          return true;
        }
        if (data === 'p' || data === 'P') {
          this.#closePicker({ quitIfEmpty: false });
          void this.#setSessionPinned(target, selected.pinned !== true);
          return true;
        }
        return false;
      },
      onCancel: () => this.#closePicker(),
      options: { width: desiredWidth, maxHeight: '80%', anchor: 'center', margin: 1 },
    });
    // The list is already sorted with the current Session first.
    if (items.length > 0) picker.list.setSelectedIndex(0);
    picker.list.onSelect = (item) => {
      this.#closePicker({ quitIfEmpty: false });
      void this.#openSession(item.value);
    };
    picker.list.onCancel = () => this.#closePicker();
  }

  #herdrError(result) {
    const stderr = typeof result?.stderr === 'string' ? result.stderr.trim() : '';
    return stderr === '' ? 'herdr command failed' : oneLine(stderr, 120);
  }

  #noteHerdrPluginSetup() {
    let root = 'path/to/dsh-attach';
    try {
      root = fileURLToPath(new URL('../../', import.meta.url));
    } catch {
      // Keep the generic hint.
    }
    this.#note(`Herdr plugin dsh-attach is not linked. Run: herdr plugin link --enabled ${shellArg(root)}`, 'warn');
  }

  async #previewRunningSubagents(argument = '') {
    if (this.state.sessionId === null) {
      this.#note('Open a session first; /subagents-preview previews its running subagents.', 'warn');
      return;
    }
    const env = process.env;
    if (env.HERDR_ENV !== '1' || typeof env.HERDR_BIN_PATH !== 'string' || typeof env.HERDR_PANE_ID !== 'string') {
      this.#note('/subagents-preview needs to run inside a Herdr pane.', 'warn');
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
    const picker = openPicker({
      modals: this.modals,
      tui: this.tui,
      slot: 'jobs',
      title: this.#jobPanelTitle(jobs),
      items: jobItems(jobs),
      hint: 'enter output · k stop · r refresh',
      onKey: (data) => this.#onJobsPanelKey(data),
      onCancel: () => this.#closeJobsPanel(),
    });
    picker.list.onSelect = (item) => {
      if (item?.job === undefined) return;
      this.#closeJobsPanel({ showNext: false, focus: false });
      void this.#openJobOutput(item.job, { returnToJobs: true });
    };
    this.jobsPanel = picker.panel;
    this.jobsList = picker.list;
    this.jobsTimer = setInterval(() => {
      if (this.modals?.has('jobs')) void this.#refreshJobsPanel();
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
    if (!this.state.connected || !this.modals?.has('jobs') || this.jobsRefreshInFlight) return;
    this.jobsRefreshInFlight = true;
    try {
      const jobs = await this.#fetchJobs();
      if (!this.modals?.has('jobs') || this.jobsList === null || this.jobsPanel === null) return;
      if (jobs.length === 0) {
        this.#note('no background jobs', 'warn');
        this.#closeJobsPanel();
        return;
      }
      setPickerItems(
        { list: this.jobsList, panel: this.jobsPanel },
        jobItems(jobs),
        this.#jobPanelTitle(jobs),
      );
      this.tui.requestRender();
    } catch (error) {
      if (this.modals?.has('jobs')) {
        this.#note(`job list refresh failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    } finally {
      this.jobsRefreshInFlight = false;
    }
  }

  #closeJobsPanel({ showNext = true, focus = true } = {}) {
    if (this.modals?.get('jobDetails')?.data?.returnTo === 'jobs') {
      this.#closeJobDetails({ focus: false, render: false });
    }
    this.modals?.close('jobs', { focus: false, render: false });
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
      onDetails: () => this.#openJobDetails(this.jobOutputJob, { returnTo: 'jobOutput' }),
      requestRender: () => this.tui.requestRender(),
    });
    panel.setText(this.jobOutputText);
    panel.setCommand(typeof job.label === 'string' ? job.label : '', job.kind);
    panel.setFooter(this.#jobFooter(job));
    panel.setKillable(jobIsLive(job));
    this.modals?.open('jobOutput', panel, { width: '86%', maxWidth: 120, maxHeight: '85%', anchor: 'center', margin: 1 });
    this.jobOutputPanel = panel;
    this.tui.requestRender();
    await this.#pollJobOutput();
    const outputJob = this.jobOutputJob;
    const outputTotal = Number(outputJob?.output?.total) || 0;
    if (this.modals?.has('jobOutput') && (jobIsLive(outputJob) || this.jobOutputFrom < outputTotal)) {
      this.jobOutputTimer = setInterval(() => {
        if (this.modals?.has('jobOutput')) void this.#pollJobOutput();
      }, 300);
      this.jobOutputTimer.unref?.();
    }
  }

  #openJobDetails(job, { returnTo = 'jobOutput' } = {}) {
    if (job === null || typeof job !== 'object') return;
    const panel = new ApprovalDetailsPanel(
      `Job ${job.id ?? 'job'} · details`,
      jobDetailsSections(job),
      {
        onClose: () => this.#closeJobDetails(),
        requestRender: () => this.tui.requestRender(),
      },
    );
    this.modals?.open(
      'jobDetails',
      panel,
      { width: '86%', maxWidth: 120, maxHeight: '85%', anchor: 'center', margin: 1 },
      { job, returnTo },
    );
    this.tui.requestRender();
  }

  #closeJobDetails({ focus = true, render = true } = {}) {
    const returnTo = this.modals?.get('jobDetails')?.data?.returnTo ?? null;
    this.modals?.close('jobDetails', { focus: false, render: false });
    if (focus) {
      const underlying = returnTo === 'jobs' ? this.modals?.get('jobs') : this.modals?.get('jobOutput');
      if (typeof underlying?.handle?.focus === 'function') underlying.handle.focus();
      else this.tui.setFocus(this.editor);
    }
    if (render) this.tui.requestRender();
  }

  async #pollJobOutput() {
    if (!this.state.connected || this.jobOutputReading || !this.modals?.has('jobOutput') || this.jobOutputJob === null) return;
    const jobId = String(this.jobOutputJob.id);
    const from = this.jobOutputFrom;
    this.jobOutputReading = true;
    try {
      const value = await this.client.request('job.read', { jobId, from });
      if (!this.#jobOutputTargetCurrent(jobId)) return;
      this.#applyJobOutputRead(value, jobId);
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

  /** Whether the response still belongs to the job-output modal being read. */
  #jobOutputTargetCurrent(jobId) {
    return this.modals?.has('jobOutput') === true
      && this.jobOutputJob !== null
      && String(this.jobOutputJob.id) === jobId;
  }

  /** Append a read's text, marking lossy history and chunk gaps once. */
  #appendJobOutput(value) {
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
  }

  /** Apply one completed job-output read to the panel and live job state. */
  #applyJobOutputRead(value, jobId) {
    this.#appendJobOutput(value);
    const next = Number(value?.next);
    if (Number.isSafeInteger(next) && next >= 0) this.jobOutputFrom = next;
    const job = value?.job ?? this.jobOutputJob;
    this.#applyJobOutputJob(job);
    this.jobOutputPanel?.setText(this.jobOutputText);
    this.jobOutputPanel?.setKillArmed(this.jobKillArmed?.id === jobId);
    if (!jobIsLive(this.jobOutputJob) && this.jobOutputFrom >= (Number(this.jobOutputJob?.output?.total) || 0)) {
      if (this.jobOutputTimer !== null) {
        clearInterval(this.jobOutputTimer);
        this.jobOutputTimer = null;
      }
    }
  }

  /** Refresh the panel header and roster entry from a read's job snapshot. */
  #applyJobOutputJob(job) {
    if (job === null || typeof job !== 'object') return;
    this.jobOutputJob = job;
    this.jobRoster.set(String(job.id), job);
    this.jobOutputPanel?.setTitle(jobTitle(job));
    this.jobOutputPanel?.setCommand(typeof job.label === 'string' ? job.label : '', job.kind);
    this.jobOutputPanel?.setFooter(this.#jobFooter(job));
    this.jobOutputPanel?.setKillable(jobIsLive(job));
  }

  #closeJobOutput({ showNext = true, focus = true, returnToJobs = this.jobOutputReturnToJobs } = {}) {
    if (this.modals?.get('jobDetails')?.data?.returnTo === 'jobOutput') {
      this.#closeJobDetails({ focus: false, render: false });
    }
    this.modals?.close('jobOutput', { focus: false, render: false });
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
      if (this.modals?.has('jobs')) void this.#refreshJobsPanel();
      if (this.modals?.has('jobOutput') && String(this.jobOutputJob?.id) === id) void this.#pollJobOutput();
    } catch (error) {
      this.#note(`cannot stop background job ${id}: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
    this.tui.requestRender();
  }

  #hostSubagentControl() {
    return subagentControlCapabilities(this.client.host);
  }

  /**
   * Load the current session's subagent catalog and action flags.
   * @returns {Promise<{picker: object, control: {continue: boolean, interrupt: boolean}}|null>}
   */
  async #loadSubagentPicker() {
    if (this.state.sessionId === null) return null;
    if (this.client.host?.capabilities?.includes('subagent.children') === true) {
      try {
        const value = await this.client.request('subagent.children', { sessionId: this.state.sessionId });
        if (value?.supported === true) {
          const control = {
            continue: value.control?.continue === true,
            interrupt: value.control?.interrupt === true,
          };
          return {
            picker: buildSubagentPickerFromRows({
              rows: value.items,
              currentSessionId: this.state.sessionId,
              control,
            }),
            control,
          };
        }
      } catch {
        // Fall back to the full session list below.
      }
    }
    const allSessions = await this.#fetchAllSessions();
    return {
      picker: buildSubagentPicker({
        sessions: allSessions,
        currentSessionId: this.state.sessionId,
        rootSessionId: this.state.sessionId,
      }),
      control: { continue: false, interrupt: false },
    };
  }

  async #loadSubagentPickerForCommand() {
    try {
      return await this.#loadSubagentPicker();
    } catch (error) {
      this.#note(`cannot list subagents: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return null;
    }
  }

  async #showSubagentPicker() {
    this.#hideAutocomplete();
    if (this.state.sessionId === null) {
      this.#note('Open a session first; /subagents lists subagents under the current session.', 'warn');
      return;
    }
    const loaded = await this.#loadSubagentPickerForCommand();
    if (loaded === null) return;
    const items = loaded.picker.items;
    if (items.length === 0) {
      this.#note('no subagents in this session', 'warn');
      return;
    }
    const runningCount = loaded.picker.running;
    const subagentPicker = openPicker({
      modals: this.modals,
      tui: this.tui,
      title: `Subagents · ${items.length}${runningCount > 0 ? ` · ${runningCount} running` : ''}`,
      items,
      hint: subagentControlHint(items),
      onCancel: () => this.#closePicker(),
      onKey: (data) => {
        if (data !== 'c' && data !== 'C' && data !== 'x' && data !== 'X') return false;
        const item = subagentPicker.list.getSelectedItem();
        if (item === null) return true;
        if (data === 'c' || data === 'C') this.#beginContinueSubagent(item, loaded.control);
        else this.#beginInterruptSubagent(item, loaded.control);
        return true;
      },
    });
    subagentPicker.list.onSelect = (item) => {
      this.#closePicker({ quitIfEmpty: false });
      void this.#openSession(item.value, { parentSessionId: item.parentSessionId });
    };
    subagentPicker.list.onCancel = () => this.#closePicker();
  }

  #subagentLabel(item) {
    return item?.plainLabel ?? String(item?.value ?? '').slice(0, 12);
  }

  #beginContinueSubagent(item, hostControl = this.#hostSubagentControl()) {
    const reason = subagentControlUnavailable(item, 'continue', hostControl);
    if (reason !== null) {
      if (this.modals?.has('picker')) this.#closePicker({ quitIfEmpty: false });
      this.#note(reason, 'warn');
      return;
    }
    if (this.modals?.has('picker')) this.#closePicker({ quitIfEmpty: false });
    this.#openContinueSubagentPrompt(item);
  }

  #openContinueSubagentPrompt(item) {
    const label = this.#subagentLabel(item);
    const panel = new TextPromptPanel(`Continue ${label}`, '', {
      hint: 'follow-up message for the subagent inbox',
      submitVerb: 'send',
      onSubmit: (value) => {
        const text = String(value ?? '').trim();
        if (text === '') {
          this.#note('the follow-up message cannot be empty', 'warn');
          return;
        }
        this.#closeSubagentContinue();
        void this.#continueSubagent(item, text);
      },
      onCancel: () => this.#closeSubagentContinue(),
      requestRender: () => this.tui.requestRender(),
    });
    this.modals?.open('subagentContinue', panel, {
      width: '82%',
      maxWidth: 110,
      maxHeight: 12,
      anchor: 'center',
      margin: 1,
    });
    this.tui.requestRender();
  }

  #closeSubagentContinue() {
    this.modals?.close('subagentContinue', { focus: false, render: false });
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  #beginInterruptSubagent(item, hostControl = this.#hostSubagentControl()) {
    const reason = subagentControlUnavailable(item, 'interrupt', hostControl);
    if (reason !== null) {
      if (this.modals?.has('picker')) this.#closePicker({ quitIfEmpty: false });
      this.#note(reason, 'warn');
      return;
    }
    if (this.modals?.has('picker')) this.#closePicker({ quitIfEmpty: false });
    this.#confirmInterruptSubagent(item);
  }

  #confirmInterruptSubagent(item) {
    const label = this.#subagentLabel(item);
    const panel = new ConfirmPanel('Stop subagent', [
      `Stop the current work of ${label}?`,
      item.mode === 'continuable'
        ? 'A continuable subagent keeps its inbox, activation and descendants and can be continued afterwards.'
        : 'A one-shot or external execution stops permanently and cannot be continued.',
    ], {
      confirmLabel: 'stop',
      onConfirm: () => {
        this.#closeSubagentConfirm();
        void this.#interruptSubagent(item);
      },
      onCancel: () => this.#closeSubagentConfirm(),
      requestRender: () => this.tui.requestRender(),
    });
    this.modals?.open('subagentConfirm', panel, {
      width: '72%',
      maxWidth: 100,
      maxHeight: 14,
      anchor: 'center',
      margin: 1,
    });
    this.tui.requestRender();
  }

  #closeSubagentConfirm() {
    this.modals?.close('subagentConfirm', { focus: false, render: false });
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  async #continueSubagent(item, text) {
    if (this.state.sessionId === null) {
      this.#note('no session is open', 'warn');
      return;
    }
    const label = this.#subagentLabel(item);
    try {
      const value = await this.client.request('subagent.continue', { childId: item.value, text });
      if (value?.supported === false) {
        this.#note(value.reason ?? 'this Host does not expose subagent continuation', 'warn');
      } else {
        this.#note(`follow-up accepted for ${label}`, 'ok');
      }
      this.log?.event('subagent-control', { action: 'continue', childId: item.value, ok: value?.supported !== false });
      this.#scheduleSubagentRefresh();
    } catch (error) {
      this.#note(subagentControlErrorText(error, 'continue'), 'error');
      this.log?.event('subagent-control', {
        action: 'continue',
        childId: item.value,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    this.tui.requestRender();
  }

  async #interruptSubagent(item) {
    if (this.state.sessionId === null) {
      this.#note('no session is open', 'warn');
      return;
    }
    const label = this.#subagentLabel(item);
    const params = { childId: item.value };
    if (typeof item.parentSessionId === 'string' && item.parentSessionId !== '') {
      params.parentSessionId = item.parentSessionId;
    }
    try {
      const value = await this.client.request('subagent.interrupt', params);
      if (value?.supported === false) {
        this.#note(value.reason ?? 'this Host does not expose subagent interruption', 'warn');
      } else {
        this.#note(`stop requested for ${label}`, 'warn');
      }
      this.log?.event('subagent-control', { action: 'interrupt', childId: item.value, ok: value?.supported !== false });
      this.#scheduleSubagentRefresh();
    } catch (error) {
      this.#note(subagentControlErrorText(error, 'stop'), 'error');
      this.log?.event('subagent-control', {
        action: 'interrupt',
        childId: item.value,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    this.tui.requestRender();
  }

  #selfSubagentItem() {
    if (!this.state.subagent || this.state.sessionId === null) return null;
    const hostControl = this.#hostSubagentControl();
    return {
      value: this.state.sessionId,
      parentSessionId: this.state.parentSessionId ?? '',
      running: this.state.running,
      mode: 'continuable',
      parentActive: true,
      canContinue: false,
      canInterrupt: hostControl.interrupt && this.state.running,
      plainLabel: this.state.title ?? 'current subagent',
    };
  }

  #resolveSubagentItem(items, token) {
    const value = String(token ?? '').trim();
    if (value === '') return null;
    const list = Array.isArray(items) ? items : [];
    const exact = list.find((item) => item.value === value);
    if (exact !== undefined) return exact;
    const lower = value.toLowerCase();
    const prefix = list.filter((item) => item.value.toLowerCase().startsWith(lower));
    if (prefix.length === 1) return prefix[0];
    if (prefix.length > 1) {
      this.#note(`multiple subagents match "${value}"; use more of the id`, 'warn');
      return null;
    }
    const named = list.filter((item) => (item.plainLabel ?? '').toLowerCase().includes(lower));
    if (named.length === 1) return named[0];
    if (named.length > 1) {
      this.#note(`multiple subagents match "${value}"; use the id instead`, 'warn');
      return null;
    }
    this.#note(`no subagent matches "${value}"`, 'warn');
    return null;
  }

  async #continueAgent(rest) {
    const argument = String(rest ?? '').trim();
    if (argument === '') {
      await this.#showSubagentPicker();
      return;
    }
    const [token, ...words] = argument.split(/\s+/u);
    const message = words.join(' ');
    const loaded = await this.#loadSubagentPickerForCommand();
    if (loaded === null) return;
    const item = this.#resolveSubagentItem(loaded.picker.items, token);
    if (item === null) return;
    const reason = subagentControlUnavailable(item, 'continue', loaded.control);
    if (reason !== null) {
      this.#note(reason, 'warn');
      return;
    }
    if (message === '') this.#openContinueSubagentPrompt(item);
    else await this.#continueSubagent(item, message);
  }

  async #interruptAgent(rest) {
    const token = String(rest ?? '').trim().split(/\s+/u)[0] ?? '';
    const self = this.#selfSubagentItem();
    if (token === '' && self !== null) {
      this.#beginInterruptSubagent(self);
      return;
    }
    if (token !== '' && self !== null && token === self.value) {
      this.#beginInterruptSubagent(self);
      return;
    }
    if (token === '') {
      await this.#showSubagentPicker();
      return;
    }
    const loaded = await this.#loadSubagentPickerForCommand();
    if (loaded === null) return;
    const item = this.#resolveSubagentItem(loaded.picker.items, token);
    if (item === null) return;
    this.#beginInterruptSubagent(item, loaded.control);
  }

  #closePicker({ quitIfEmpty = true } = {}) {
    this.modals?.close('picker', { focus: false, render: false });
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
    const previousSessionId = this.state.sessionId;
    if (previousSessionId !== null && previousSessionId !== sessionId) {
      this.drafts.set(String(previousSessionId), this.editor.getText());
      this.imagesBySession.set(String(previousSessionId), this.pendingImages.slice());
    }
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
    this.skills = [];
    this.skillsCwd = null;
    this.skillsLoaded = false;
    this.skillsComplete = true;
    this.skillsRequest = null;
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
      goalActivation: null,
      plan: null,
      note: null,
      subagent: isSubagent,
      parentSessionId: isSubagent ? String(parent) : null,
      subagents: { total: 0, running: 0, items: [] },
    };
    if (previousSessionId !== sessionId) {
      this.editor.setText(this.drafts.get(String(sessionId)) ?? '');
      this.editor.cancelAutocomplete();
      this.pendingImages = (this.imagesBySession.get(String(sessionId)) ?? []).slice();
    }
    this.#installAutocomplete();
    try {
      await this.client.request('session.open', {
        sessionId,
        ...(isSubagent ? { parentSessionId: String(parent), mode: 'unknown' } : {}),
        env: herdrEnvironment(),
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
    await this.#createSessionAt(this.state.cwd ?? this.options.cwd ?? process.cwd());
  }

  // ── prompts and commands ─────────────────────────────────────────────────

  async #onSubmit(text) {
    const value = String(text ?? '').trim();
    const images = this.pendingImages.slice();
    if (value === '' && images.length === 0) return;
    // Sending a prompt is a return to the live edge. This also resumes
    // auto-follow when the reader had scrolled back through history. Loading
    // older history is the exception: it must preserve the reader's position.
    const historyCommand = value.startsWith('/')
      && ['/history', '/earlier'].includes(parseLocalCommand(value).name);
    if (!historyCommand) {
      this.transcript.scrollToEnd();
      this.tui.requestRender();
    }
    if (value !== '') this.editor.addToHistory(value);
    if (value.startsWith('/')) {
      await this.#command(value);
      this.#syncAutocomplete();
      return;
    }
    await this.#submitPrompt(value, 'queue', images);
    this.#syncAutocomplete();
  }

  async #submitPrompt(text, mode, images = this.pendingImages, options = {}) {
    const attachments = Array.isArray(images) ? images.slice() : [];
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
    const label = text === '' ? `[${attachments.length} image${attachments.length === 1 ? '' : 's'}]` : text;
    const echo = new UserRow(label, sub);
    this.#addRow(echo, { blankBefore: true });
    this.echoes.push({ row: echo, text: label });
    try {
      await this.client.request('session.prompt', {
        text,
        mode,
        images: attachments.map((image) => ({
          mediaType: image.mediaType,
          data: image.data,
          name: image.name,
        })),
        ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      });
      if (attachments.length > 0) {
        this.pendingImages = this.pendingImages.filter((image) => !attachments.includes(image));
        this.tui.requestRender();
      }
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

  async #pasteClipboardImage({ quiet = false, textFallback = false } = {}) {
    if (this.clipboardPastePending) return;
    if (this.state.subagent) {
      if (!quiet) this.#note('Subagent conversations are read-only here.', 'warn');
      return;
    }
    if (this.state.sessionId === null) {
      if (!quiet) this.#note('Open a session first.', 'warn');
      return;
    }
    if (this.pendingImages.length >= 8) {
      if (!quiet) this.#note('at most 8 images can be attached', 'warn');
      return;
    }
    this.clipboardPastePending = true;
    try {
      const image = await this.readClipboardImage();
      this.pendingImages.push(image);
      this.tui.requestRender();
    } catch (error) {
      if (textFallback) {
        const text = await this.readClipboardText().catch(() => '');
        if (text !== '') {
          this.editor.insertTextAtCursor(text);
          this.tui.requestRender();
          return;
        }
      }
      if (!quiet) this.#note(`cannot paste image: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.clipboardPastePending = false;
    }
  }

  async #resumeInterruptedTurn(turn) {
    const requestId = interruptedResumeRequestId(this.state.sessionId, turn);
    if (!shouldResumeInterrupted({
      reason: this.state.reason,
      running: this.state.running,
      subagent: this.state.subagent,
      pending: this.#pendingQueueCount(),
      attempted: this.resumeAttempts.has(requestId),
      enabled: process.env.DSH_ATTACH_AUTO_RESUME !== '0',
    })) return;
    this.resumeAttempts.add(requestId);
    this.#note('Host restarted during the previous turn; continuing…', 'warn');
    await this.#submitPrompt(INTERRUPTED_RESUME_PROMPT, 'queue', [], { requestId });
  }

  #renderImages(width) {
    if (this.pendingImages.length === 0) return '';
    const names = this.pendingImages.map((image) => image.name ?? 'clipboard.png').join(', ');
    return truncateToWidth(yellow(`${this.pendingImages.length} image${this.pendingImages.length === 1 ? '' : 's'} attached · ${sanitizeText(names)} · /images clear`), width);
  }

  async #command(text) {
    const handled = await executeLocalCommand(text, {
      help: () => this.#openInfo('Help', HELP_LINES),
      sessions: async () => {
        try {
          await this.#showSessionPicker();
        } catch (error) {
          this.#note(`cannot load sessions: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
      },
      reconnect: () => this.#forceReconnect(),
      pasteImage: () => this.#pasteClipboardImage(),
      images: () => this.#note(this.pendingImages.length === 0 ? 'no images attached' : `${this.pendingImages.length} image(s) attached`, 'dim'),
      clearImages: () => { this.pendingImages = []; this.tui.requestRender(); },
      agents: () => this.#showSubagentPicker(),
      continueAgent: (rest) => this.#continueAgent(rest),
      interruptAgent: (rest) => this.#interruptAgent(rest),
      jobs: () => this.#showJobsPanel(),
      jobOutput: (id) => this.#openJobOutputById(id),
      killJob: (id) => this.#killJobById(id),
      previewAgents: (rest) => this.#previewRunningSubagents(rest),
      togglePeek: () => this.#togglePeek(),
      parent: () => this.#openParent(),
      openSession: async (id) => {
        try {
          await this.#openSession(id);
        } catch {
          // #openSession reports the failure.
        }
      },
      newSession: (rest, options) => this.#createSessionAt(rest, options),
      forkSession: (id) => this.#forkSession(id),
      archiveSession: (id, options) => this.#archiveSession(id, options),
      unarchiveSession: (id) => this.#unarchiveSession(id),
      pinSession: (id) => this.#setSessionPinned(id, true),
      unpinSession: (id) => this.#setSessionPinned(id, false),
      sessionPresets: () => this.#showSessionPresets(),
      sessionPresetPicker: () => this.#showSessionPresetPicker(),
      sessionPreset: (id) => this.#setNewSessionPreset(id),
      deleteSession: (id) => this.#deleteSession(id),
      rename: (title) => this.#renameSession(title),
      cancel: () => this.#cancelTurn('command'),
      submitPrompt: (value, mode) => this.#submitPrompt(value, mode),
      queueManager: () => this.#showQueueManager(),
      goal: (command) => this.#goalCommand(command),
      plan: (command) => this.#planCommand(command),
      find: (rest) => this.#findTranscript(rest),
      loadEarlierHistory: () => this.#loadEarlierHistory(),
      model: (rest) => this.#modelCommand(rest),
      skillsList: () => this.#showSkills(),
      skillShow: (name) => this.#showSkill(name),
      skillRun: (name) => this.#runSkill(name),
      todos: () => this.#showTodos(),
      detail: (value) => this.#setDetailLevel(value),
      btw: (question) => { void this.#askBtw(question); },
      permission: (rest) => (rest === '' ? this.#showPermissionPicker() : this.#applyPermission(rest)),
      status: () => this.#openInfo('Status', this.#statusLines()),
      quit: () => this.quit('command'),
      note: (value, tone) => this.#note(value, tone),
    });
    if (handled) return;
    // Host-registered commands run inside the Host. If the Host does not know
    // the name (or is an older build without the command routes), the line
    // falls back to a normal prompt.
    if (await this.#executeHostCommand(text)) return;
    await this.#submitPrompt(text, 'queue');
  }

  #findTranscript(query = '') {
    const text = String(query ?? '').trim();
    const width = this.terminal?.columns ?? process.stdout.columns ?? 80;
    const items = buildTranscriptSearch(this.rows, width);
    if (items.length === 0) {
      this.#note('transcript is empty', 'warn');
      return;
    }
    if (text !== '') {
      const match = firstTranscriptMatch(items, text);
      if (match === null) {
        this.#note(`no transcript match for ${text}`, 'warn');
        return;
      }
      this.transcript.scrollTo(match.offset);
      this.tui.requestRender();
      this.#note(`match · ${match.description}`, 'dim');
      return;
    }
    this.#hideAutocomplete();
    const finder = openPicker({
      modals: this.modals,
      tui: this.tui,
      title: `Find in transcript · ${items.length} rows`,
      items,
      maxVisible: 12,
      onCancel: () => this.#closePicker(),
    });
    finder.list.onSelect = (item) => {
      this.#closePicker({ quitIfEmpty: false });
      this.transcript.scrollTo(item.offset);
      this.tui.requestRender();
    };
    finder.list.onCancel = () => this.#closePicker();
    this.tui.requestRender();
  }

  #togglePeek() {
    this.peekEnabled = !this.peekEnabled;
    if (!this.peekEnabled) this.#stopPeeks();
    this.#note(this.peekEnabled ? 'subagent peek enabled' : 'subagent peek disabled', 'ok');
    if (this.peekEnabled) void this.#refreshSubagents();
    this.tui.requestRender();
  }

  async #openParent() {
    if (this.state.parentSessionId === null || this.state.parentSessionId === '') {
      this.#note('no parent session for this view', 'warn');
      return;
    }
    try {
      await this.#openSession(this.state.parentSessionId);
    } catch {
      // #openSession reports the failure.
    }
  }

  async #createSessionAt(rest, options = {}) {
    const requested = String(rest ?? '').trim();
    const cwd = requested === ''
      ? this.options.cwd ?? process.cwd()
      : requested.replace(/^~(?=\/|$)/u, process.env.HOME ?? '~');
    const requestedPreset = typeof options.agentPreset === 'string' && options.agentPreset !== ''
      ? options.agentPreset
      : this.newSessionPreset;
    try {
      const value = await this.client.request('session.create', {
        cwd,
        ...(requestedPreset === null || requestedPreset === undefined || requestedPreset === ''
          ? {}
          : { agentPreset: requestedPreset }),
      });
      this.sessionListCache = null;
      this.workspaceCache = null;
      await this.#openSession(value.sessionId);
      this.#note(`new session ${value.sessionId.slice(0, 12)} in ${cwd}${requestedPreset ? ` · preset ${requestedPreset}` : ''}`, 'ok');
    } catch (error) {
      this.#note(`cannot create session: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async #renameSession(title) {
    try {
      await this.client.request('session.rename', { title });
      this.sessionListCache = null;
      this.state.title = title;
      this.tui.requestRender();
    } catch (error) {
      this.#note(`rename failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async #killJobById(jobId) {
    try {
      const jobs = await this.#fetchJobs();
      const job = jobs.find((entry) => String(entry.id) === jobId);
      if (job === undefined) {
        this.#note(`background job not found: ${jobId}`, 'warn');
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
  }

  async #goalCommand(command) {
    if (this.state.sessionId === null) {
      this.#note('Open a session first; /goal manages its session goal.', 'warn');
      return;
    }
    if (command?.kind === 'usage') {
      this.#note(command.message ?? 'usage: /goal [status|create <objective>|edit [objective]|pause|resume|complete|clear]', 'warn');
      return;
    }
    if (command?.kind === 'status') {
      await this.#refreshGoalActivation();
      this.#openInfo('Goal', goalStatusLines(this.state.goal, this.state.goalActivation));
      return;
    }
    if (command?.kind === 'edit') {
      await this.#refreshGoalActivation();
      await this.#editGoalObjective(command.objective);
      return;
    }
    if (command?.kind === 'clear') {
      await this.#refreshGoalActivation();
      if (this.state.goal === null) {
        this.#note('No goal to clear.', 'dim');
        return;
      }
      this.#confirmGoalAction({
        title: 'Clear goal?',
        text: `Clear "${oneLine(this.state.goal.objective ?? '', 100)}"? Its durable history remains in the session log, but the goal cannot be resumed.`,
        run: () => this.#runGoalCommand('/goal clear'),
      });
      return;
    }
    if (command?.kind === 'complete') {
      await this.#refreshGoalActivation();
      if (this.state.goal === null) {
        this.#note('No goal is currently set; nothing to complete.', 'warn');
        return;
      }
      if (this.client.host?.capabilities?.includes('goal.complete') !== true) {
        this.#note('This Host does not support goal completion; upgrade the Host plugin.', 'warn');
        return;
      }
      this.#confirmGoalAction({
        title: 'Complete goal?',
        text: `Mark "${oneLine(this.state.goal.objective ?? '', 100)}" complete? This disarms continuation and a complete goal cannot be resumed.`,
        run: () => this.#completeGoal(),
      });
      return;
    }
    const line = goalHostLine(command);
    if (line === null) {
      this.#note('usage: /goal [status|create <objective>|edit [objective]|pause|resume|complete|clear]', 'warn');
      return;
    }
    await this.#runGoalCommand(line);
  }

  async #runGoalCommand(line) {
    const handled = await this.#executeHostCommand(line);
    if (!handled) {
      this.#note(`this Host does not expose ${line.split(/\s+/u)[0]}; check the Host plugin with /status.`, 'warn');
      return false;
    }
    await this.#refreshGoalActivation();
    return true;
  }

  async #editGoalObjective(objective) {
    if (this.state.goal === null) {
      this.#note('No goal is currently set; create one with /goal <objective>.', 'warn');
      return;
    }
    const text = String(objective ?? '').trim();
    if (text !== '') {
      await this.#runGoalCommand(`/goal edit ${text}`);
      return;
    }
    this.#hideAutocomplete();
    const panel = new TextPromptPanel('Edit goal objective', this.state.goal.objective ?? '', {
      hint: 'replace the current goal objective',
      onSubmit: (value) => {
        const next = String(value ?? '').trim();
        if (next === '') {
          this.#note('goal objective cannot be empty', 'warn');
          return;
        }
        this.#closeGoalEdit();
        void this.#runGoalCommand(`/goal edit ${next}`);
      },
      onCancel: () => this.#closeGoalEdit(),
      requestRender: () => this.tui.requestRender(),
    });
    this.modals?.open('goalEdit', panel, { width: '82%', maxWidth: 110, maxHeight: 12, anchor: 'center', margin: 1 });
    this.tui.requestRender();
  }

  #closeGoalEdit({ focus = true } = {}) {
    this.modals?.close('goalEdit', { focus: false, render: false });
    if (focus) this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  #confirmGoalAction({ title, text, run }) {
    if (this.state.interactive !== null) {
      this.#note('Answer the pending prompt before changing the goal.', 'warn');
      return;
    }
    this.#hideAutocomplete();
    const panel = new ConfirmPanel(title, [text], {
      onConfirm: () => {
        this.#closeConfirm({ focus: false });
        void run();
      },
      onCancel: () => this.#closeConfirm(),
      requestRender: () => this.tui.requestRender(),
    });
    this.modals?.open('confirm', panel, { width: '72%', maxWidth: 92, maxHeight: 16, anchor: 'center', margin: 1 });
    this.tui.requestRender();
  }

  #closeConfirm({ focus = true } = {}) {
    this.modals?.close('confirm', { focus: false, render: false });
    if (focus) this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  async #completeGoal() {
    try {
      const value = await this.client.request('goal.complete');
      const goal = normalizeGoal(value?.goal);
      if (goal !== null) {
        this.state.goal = goal;
        this.state.goalActivation = typeof value.goal?.activation === 'string' ? value.goal.activation : 'disarmed';
        this.#note(`goal complete · ${oneLine(goal.objective ?? '', 80)}`, 'ok');
      } else {
        await this.#refreshGoalActivation();
        this.#note('goal completed', 'ok');
      }
      this.tui.requestRender();
    } catch (error) {
      if (error?.code === 'attach/unknown-method' || error?.code === 'attach/unsupported') {
        this.#note('This Host does not support goal completion; upgrade the Host plugin.', 'warn');
        return;
      }
      this.#note(`cannot complete goal: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async #planCommand(command) {
    if (this.state.sessionId === null) {
      this.#note('Open a session first; /plan controls its plan mode.', 'warn');
      return;
    }
    if (command?.kind === 'status') {
      this.#openInfo('Plan mode', planStatusLines(this.state.plan, { review: this.#hasPlanReview() }));
      return;
    }
    if (command?.kind === 'approve') {
      this.#note(
        this.#hasPlanReview()
          ? 'Use the open plan-review panel to choose Approve or Keep planning.'
          : 'No plan review is open. The model opens one through exit_plan_mode while plan mode is active; use /plan off to leave plan mode.',
        'warn',
      );
      return;
    }
    const line = planHostLine(command);
    if (line === null) {
      this.#note('usage: /plan [status|enter [message]|exit]', 'warn');
      return;
    }
    const handled = await this.#executeHostCommand(line);
    if (!handled) this.#note('this Host does not expose /plan; check the Host plugin with /status.', 'warn');
  }

  #hasPlanReview() {
    for (const message of [this.activeInteractive, ...this.interactiveQueue]) {
      if (message?.type !== 'question') continue;
      if ((message.questions ?? []).some((question) => question?.intent?.kind === 'plan-review')) return true;
    }
    return false;
  }

  async #modelCommand(rest) {
    if (rest === '') {
      await this.#showModelPicker();
      return;
    }
    const [provider, ...modelParts] = rest.split(/\s+/u);
    const model = modelParts.join(' ');
    if (provider === undefined || model === '') {
      this.#note('usage: /model <provider> <model>', 'warn');
      return;
    }
    await this.#selectModel({ provider, model });
  }

  #showPermissionPicker() {
    this.#hideAutocomplete();
    const current = this.state.permission === null ? '' : ` · current ${this.state.permission}`;
    const picker = openPicker({
      modals: this.modals,
      tui: this.tui,
      title: `Permission preset${current}`,
      items: PERMISSION_PRESETS.map((preset) => ({ ...preset })),
      maxVisible: 6,
      onCancel: () => this.#closePicker(),
    });
    picker.list.onSelect = (item) => {
      this.#closePicker();
      void this.#applyPermission(item.value);
    };
    picker.list.onCancel = () => this.#closePicker();
    this.tui.requestRender();
  }

  async #applyPermission(value) {
    const preset = PERMISSION_PRESETS.find((item) => item.value === value);
    if (preset === undefined) {
      this.#note(`permission must be one of ${PERMISSION_PRESETS.map((item) => item.value).join(', ')}`, 'warn');
      return;
    }
    const handled = await this.#executeHostCommand(`/permission ${preset.value}`);
    if (!handled) this.#note('this Host does not expose /permission', 'warn');
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
      const items = modelPickerItems(catalog);
      if (items.length === 0) {
        this.#note('no routable model is available', 'warn');
        return;
      }
      const modelPicker = openPicker({
        modals: this.modals,
        tui: this.tui,
        title: 'Select model',
        items,
        maxVisible: Math.min(14, items.length),
        onCancel: () => this.#closePicker(),
      });
      modelPicker.list.onSelect = (item) => {
        this.#closePicker();
        void this.#selectModel(JSON.parse(item.value));
      };
      modelPicker.list.onCancel = () => this.#closePicker();
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
      const effort = typeof selected.reasoningEffort === 'string' && selected.reasoningEffort !== '' ? ` · effort ${selected.reasoningEffort}` : '';
      this.#note(`model switched to ${selected.provider}/${selected.model}${effort}`, 'ok');
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
      `new preset ${this.newSessionPreset ?? '(Host default)'}`,
      `sandbox   ${state.permission ?? '—'}`,
      `context   ${formatCount(used)} / ${formatCount(window)} (${percent})`,
      `tokens    ↑${formatCount(state.tokens?.inputTokens)} ↓${formatCount(state.tokens?.outputTokens)} cache ${formatCount(state.tokens?.cacheReadTokens)}`,
      `todos     ${todos.filter((todo) => todo.status === 'completed').length}/${todos.length}`,
      `queued    ${this.#pendingQueueCount()}`,
      `jobs      ${runningJobCount([...this.jobRoster.values()])} running / ${this.jobRoster.size} total`,
      historyStatusLine({
        hasMore: this.historyHasMore,
        loading: this.historyLoading,
        loadedPages: this.historyLoadedPages,
        trimmedRows: this.trimmedRows,
        hostSupports: this.#historyPagingSupported(),
      }),
      `goal      ${goalStatus(state.goal, state.goalActivation)}`,
      `timing    ${state.running
        ? (() => {
            const startedAt = this.currentTurnFold?.startedAt ?? this.turnStartedAt;
            return Number.isFinite(startedAt)
              ? `running since ${formatClock(startedAt)} (${formatDuration(Date.now() - startedAt)})`
              : 'running';
          })()
        : (this.lastTurnCompletedAt === null ? '—' : `last completed ${formatClock(this.lastTurnCompletedAt)}`)}`,
      `host      pid ${this.client.host?.pid ?? '—'} · ${this.client.host?.profile ?? '—'} · plugin ${this.client.host?.pluginVersion ?? '—'} · protocol ${this.client.host?.protocol ?? '—'}`,
      ...(this.state.subagent
        ? [`subagent  history read-only · parent ${this.state.parentSessionId?.slice(0, 12) ?? '—'} · backspace/alt+left parent`]
        : []),
      `theme     ${this.theme} (--theme light|dark)`,
      `socket    ${this.client.descriptor?.socketPath ?? '—'}`,
      '',
      `detail    ${this.detailLevel} · ctrl+g cycle compact/standard/verbose`, 
    ];
    return lines;
  }

  /** Ask an ephemeral side question without touching the session turn. */
  async #askBtw(question) {
    const text = String(question ?? '').trim();
    if (text === '') {
      if (this.btwHistory.length === 0) {
        this.#note('usage: /btw <question>', 'warn');
        return;
      }
      this.#openBtwPanel(this.btwHistory.length - 1);
      return;
    }
    if (this.btwActive !== null) {
      this.#note('a side question is already running; wait for it or close the card', 'warn');
      this.#openBtwPanel(this.btwHistory.indexOf(this.btwActive));
      return;
    }
    const entry = { question: text, status: 'answering', answer: '', reasoning: '', error: false };
    this.btwHistory.push(entry);
    if (this.btwHistory.length > 20) this.btwHistory.shift();
    this.btwActive = entry;
    this.#openBtwPanel(this.btwHistory.length - 1);
    const sequence = ++this.btwSeq;
    try {
      const value = await this.client.request('btw.ask', { question: text });
      entry.status = 'done';
      entry.answer = typeof value?.answer === 'string' ? value.answer : '(no answer)';
      entry.reasoning = typeof value?.reasoning === 'string' ? value.reasoning : '';
    } catch (error) {
      entry.status = 'error';
      entry.error = true;
      entry.answer = error?.code === 'attach/unknown-method'
        ? 'side questions need a DSH restart to load the btw.ask route'
        : `side question failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (sequence === this.btwSeq) this.btwActive = null;
      const panel = this.modals?.get('btw')?.component;
      const index = this.btwHistory.indexOf(entry);
      if (panel !== undefined && panel !== null && index >= 0) panel.setEntry(index, entry);
    }
  }

  #openBtwPanel(index = this.btwHistory.length - 1) {
    if (this.btwHistory.length === 0) return;
    this.#hideAutocomplete();
    const panel = new BtwPanel(this.btwHistory, index, {
      onClose: () => this.#closeBtw(),
      onFork: (entry) => { void this.#forkBtw(entry); },
      requestRender: () => this.tui.requestRender(),
    });
    this.modals?.open('btw', panel, { width: '84%', maxWidth: 120, maxHeight: '80%', anchor: 'center', margin: 1 });
  }

  async #forkBtw(entry) {
    if (entry === undefined || entry === null) return;
    if (!this.#hasCapability('session.fork')) {
      this.#note('this Host does not expose session forking', 'warn');
      return;
    }
    this.#closeBtw({ focus: false });
    try {
      const value = await this.client.request('session.fork', { sessionId: this.state.sessionId });
      const childId = typeof value?.sessionId === 'string' ? value.sessionId : '';
      if (childId === '') throw new Error('Host returned no fork session id');
      this.sessionListCache = null;
      this.workspaceCache = null;
      await this.#openSession(childId);
      const answer = entry.status === 'done' ? entry.answer : '(no answer)';
      await this.#submitPrompt(
        `Continue from this side question with full tool access.\n\nQuestion: ${entry.question}\n\nSide answer (answered without tools):\n${answer}\n\nVerify anything needed and continue.`,
        'queue',
      );
      this.#note(`btw forked → ${childId.slice(0, 12)} · tools enabled`, 'ok');
    } catch (error) {
      this.#note(`btw fork failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  #closeBtw({ focus = true } = {}) {
    this.modals?.close('btw', { focus: false, render: false });
    if (focus) {
      this.tui.setFocus(this.editor);
      this.#showNextInteractive();
    }
    this.tui.requestRender();
  }

  #openInfo(title, lines) {
    this.#hideAutocomplete();
    const panel = new InfoPanel(title, lines, () => this.#closeInfo());
    this.modals?.open('info', panel, { width: '84%', maxWidth: 120, maxHeight: '85%', anchor: 'center', margin: 1 });
  }

  #closeInfo() {
    this.modals?.close('info', { focus: false, render: false });
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
    if (this.modals?.has('btw')) this.#closeBtw({ focus: false });
    if (this.modals?.has('info')) this.#closeInfo();
    if (this.modals?.has('picker')) this.#closePicker({ quitIfEmpty: false });
    if (this.modals?.has('confirm')) this.#closeConfirm({ focus: false });
    if (this.modals?.has('goalEdit')) this.#closeGoalEdit({ focus: false });
    this.tui.requestRender();
    this.#showNextInteractive();
    this.#ringBell();
  }

  #showNextInteractive() {
    if (this.activeInteractive !== null) return;
    this.#hideApprovalDetails();
    if (this.modals?.has('info') || this.modals?.has('picker') || this.modals?.has('btw')) return;
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
        context: {
          sessionId: this.state.sessionId,
          cwd: this.state.cwd,
          permission: this.state.permission,
          provider: this.state.provider,
          model: this.state.model,
        },
        onDetails: () => this.#openApprovalDetails(next, panel.detailsSections()),
        onDetach: () => this.#detachInteractive(next, 'approval'),
      });
      this.modals?.open(
        'interactive',
        panel,
        { width: '78%', maxWidth: 100, maxHeight: 40, anchor: 'center', margin: 1 },
      );
    } else {
      this.modals?.open(
        'interactive',
        new QuestionPanel(next, {
          onSubmit: (answer) => this.#answerQuestion(next, answer),
          onCancel: () => this.#answerQuestion(next, null),
          requestRender: () => this.tui.requestRender(),
        }),
        { width: '82%', maxWidth: 110, maxHeight: '82%', anchor: 'center', margin: 1 },
      );
    }
    void this.client.request('interactive.ack', { requestId: next.requestId }).catch(() => {});
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
    this.modals?.open('approvalDetails', panel, {
      width: '86%',
      maxWidth: 120,
      maxHeight: '85%',
      anchor: 'center',
      margin: 1,
    });
    this.tui.requestRender();
  }

  #closeApprovalDetails() {
    if (!this.modals?.has('approvalDetails')) return;
    this.#hideApprovalDetails();
    const interactive = this.modals?.get('interactive');
    if (interactive !== null && interactive !== undefined) interactive.handle.focus();
    else this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  #hideApprovalDetails() {
    this.modals?.close('approvalDetails', { focus: false, render: false });
  }

  #closeInteractive() {
    this.#hideApprovalDetails();
    this.modals?.close('interactive', { focus: false, render: false });
    this.activeInteractive = null;
    this.state.interactive = this.interactiveQueue.length > 0 ? this.interactiveQueue[0].type : null;
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
    this.#reportHerdr();
    setTimeout(() => this.#showNextInteractive(), 20);
  }

  #detachInteractive(message, kind) {
    this.#closeInteractive();
    this.#note(`${kind} detached; another client or timeout can answer it`, 'warn');
    void this.client.request('interactive.detach', { requestId: message.requestId }).catch((error) => {
      this.#note(`${kind} detach failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    });
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
    if (answer === null) {
      this.#detachInteractive(message, 'question');
      return;
    }
    this.#closeInteractive();
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
      this.modals?.close('interactive', { focus: false, render: false });
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
  `${bold('prompting')}   enter send · /steer <text> interrupt+steer · /queue <text> queue · ctrl+v image · /image paste`,
  `${bold('sessions')}    /session [list|new|resume|rename|fork|archive|pin|preset] · /reconnect retry`,
  `${bold('subagents')}   /subagent [list|continue|interrupt|stop|preview|parent|peek] · backspace/alt+left parent`,
  `${bold('jobs')}        /job [list|output|kill] · enter output · d details · count in activity`,
  `${bold('skills')}      /skill [list|show|run] · /name invokes a user skill · names complete after /`,
  `${bold('todos')}       /todo show the current plan · status also appears in the activity line`,
  `${bold('goal')}        /goal [status|create|edit|pause|resume|complete|clear] · complete/clear ask first`,
  `${bold('plan')}        /plan [status|enter [message]|exit] · approve plans in the review panel`,
  `${bold('btw')}         /btw <question> side question without touching the turn · bare /btw reopens`,
  `${bold('turn')}        /cancel or esc esc stop the running turn · esc closes panels`,
  `${bold('approval')}    y allow once · n reject · enter/d details · esc detach`,
  `${bold('model')}       /model pick provider/model · /status session details`,
  `${bold('display')}     ctrl+g detail (compact/standard/verbose) · pgup/pgdn · alt+v · ctrl+alt+f/b · ctrl+l end`,
  `${bold('history')}     ctrl+r or /history load older messages · up/ctrl+p previous prompt · /find search loaded transcript`,
  `${bold('emacs')}       ctrl+n/p move · ctrl+a/e line · ctrl+b/f char · ctrl+k/u/w/y kill/yank`,
  `${bold('args')}        /session resume, /job output, /skill show, /goal, /plan, /model and /permission complete · completions float above input`,
  `${bold('exit')}        ctrl+c when idle / twice when active · /quit`,
  '',
  `${faint('Unknown slash commands first go through the Host command registry, then fall back to a prompt.')}`,
];
