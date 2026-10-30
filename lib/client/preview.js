/**
 * Lightweight read-only preview for one Session/subagent.
 *
 * This is deliberately separate from AttachApp: a preview pane has no editor,
 * completion provider, approval UI, timers or Herdr agent reporting. It only
 * follows the Session stream and paints the last screenful of output.
 */
import { matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import {
  AssistantRow,
  BlankRow,
  CachedRow,
  NoteRow,
  ToolRow,
  UserRow,
  oneLine,
  partsOfMessage,
  textOfContent,
} from './transcript.js';
import { accent, bold, dim, faint, green, red, setTheme, yellow } from './theme.js';
import { fitRight } from './layout.js';

/**
 * Run the preview until the user exits. Returns true when the Session opened.
 * @param {import('./connection.js').AttachClient} client
 * @param {{sessionId: string, parentSessionId?: string, theme?: 'light'|'dark', cwd?: string}} options
 */
export async function runPreview(client, options) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('preview needs a TTY');
  }
  setTheme(options.theme ?? 'light');
  const sessionId = String(options.sessionId);
  const parentSessionId = options.parentSessionId === undefined || options.parentSessionId === null
    ? null
    : String(options.parentSessionId);
  const rows = [];
  const tools = new Map();
  let live = null;
  let title = null;
  let cwd = options.cwd ?? '';
  let running = options.expectRunning === true;
  let blocked = null;
  let closed = false;
  let failed = null;
  let renderTimer = null;
  let finished = false;
  let scrollBack = 0;
  const autoExitMs = Math.max(0, Number(options.exitAfterSeconds ?? 0) * 1000) || 0;
  let autoExitTimer = null;
  let autoExitTicker = null;
  let autoExitAt = null;

  const add = (component, { blankBefore = false } = {}) => {
    if (blankBefore && rows.length > 0) rows.push(new CachedRow(new BlankRow()));
    rows.push(new CachedRow(component));
    if (rows.length > 800) rows.splice(0, rows.length - 800);
  };
  const addNote = (text, tone = 'dim') => add(new NoteRow(text, tone));
  const ensureLive = () => {
    if (live !== null) return live;
    const row = new AssistantRow('', { streaming: true });
    add(row);
    live = { row, text: '' };
    return live;
  };
  const finalizeLive = (text) => {
    if (live === null) {
      if (text !== '') add(new AssistantRow(text));
      return;
    }
    const current = live;
    live = null;
    current.row.setText(text === '' ? current.text : text);
    current.row.finalize();
  };

  const renderNow = () => {
    if (renderTimer !== null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    if (finished) return;
    const width = Math.max(20, process.stdout.columns ?? 80);
    const height = Math.max(4, process.stdout.rows ?? 24);
    const bodyHeight = height - 2;
    if (live !== null) live.row.setText(live.text);
    const body = [];
    for (const row of rows) {
      for (const line of row.render(width)) body.push(line);
      body.push('');
    }
    const maxScroll = Math.max(0, body.length - bodyHeight);
    scrollBack = Math.min(scrollBack, maxScroll);
    const start = Math.max(0, body.length - bodyHeight - scrollBack);
    const visible = body.slice(start, start + bodyHeight);
    while (visible.length < bodyHeight) visible.unshift('');
    const state = failed !== null
      ? red('error')
      : closed
        ? red('closed')
        : blocked !== null
          ? yellow('blocked')
          : running
            ? green('running')
            : faint('idle');
    const left = `${accent('preview')} ${dim('·')} ${bold(oneLine(title ?? sessionId, Math.max(10, width - 28)))}`;
    const right = `${state}${cwd === '' ? '' : ` ${dim('·')} ${dim(oneLine(cwd, Math.max(8, Math.floor(width / 3))))}`}`;
    const header = fitRight(left, right, width, { gap: 1 });
    const autoHint = autoExitAt === null
      ? ''
      : `auto-close ${Math.max(1, Math.ceil((autoExitAt - Date.now()) / 1000))}s · `;
    const footer = fitRight(
      faint(`read-only${scrollBack > 0 ? ` · ${scrollBack} lines back` : ''}${failed === null ? '' : ` · ${oneLine(failed, 80)}`}`),
      faint(`${autoHint}pgup/pgdn scroll · ctrl+c close`),
      width,
      { gap: 1 },
    );
    let out = '\x1b[?2026h';
    const screen = [header, ...visible, footer];
    for (let index = 0; index < height; index += 1) {
      out += `\x1b[${index + 1};1H\x1b[2K${truncateToWidth(screen[index] ?? '', width)}`;
    }
    out += '\x1b[?2026l';
    try {
      process.stdout.write(out);
    } catch {
      // The pane may be gone.
    }
  };
  const schedule = () => {
    if (renderTimer !== null) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderNow();
    }, 80);
    renderTimer.unref?.();
  };

  const clearAutoExit = () => {
    if (autoExitTimer !== null) {
      clearTimeout(autoExitTimer);
      autoExitTimer = null;
    }
    if (autoExitTicker !== null) {
      clearInterval(autoExitTicker);
      autoExitTicker = null;
    }
    autoExitAt = null;
  };

  const scheduleAutoExit = (delayMs = autoExitMs) => {
    if (autoExitMs <= 0 || finished) return;
    clearAutoExit();
    const delay = Math.max(0, Number(delayMs) || 0);
    autoExitAt = Date.now() + delay;
    autoExitTimer = setTimeout(() => {
      autoExitTimer = null;
      if (!finished) cleanup();
    }, delay);
    autoExitTimer.unref?.();
    autoExitTicker = setInterval(() => {
      if (!finished) renderNow();
    }, 1_000);
    autoExitTicker.unref?.();
    schedule();
  };

  const cancelAutoExit = () => {
    if (autoExitAt === null && autoExitTimer === null && autoExitTicker === null) return;
    clearAutoExit();
    schedule();
  };

  const replayAttempt = (attempt) => {
    if (attempt === null || typeof attempt !== 'object') return;
    const current = ensureLive();
    current.text = '';
    for (const record of Array.isArray(attempt.stream) ? attempt.stream : []) {
      if (record?.type === 'chunk' && (record.chunk?.type === 'text-delta' || record.chunk?.type === 'reasoning-delta')) {
        if (record.chunk.type === 'text-delta') current.text += record.chunk.text ?? '';
      } else if (record?.type === 'text-chunks' && Array.isArray(record.texts)) {
        current.text += record.texts.join('');
      }
    }
  };

  const handleEvent = (event) => {
    if (event === null || typeof event !== 'object') return;
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
    switch (event.type) {
      case 'user/message': {
        cancelAutoExit();
        const text = textOfContent(data.content);
        if (text.trim() !== '') add(new UserRow(text), { blankBefore: true });
        return;
      }
      case 'assistant/message': {
        cancelAutoExit();
        const { text } = partsOfMessage(data.message);
        finalizeLive(text);
        if (text.trim() !== '') add(new BlankRow());
        return;
      }
      case 'tool/call': {
        if (typeof data.callId !== 'string' || typeof data.name !== 'string') return;
        const row = new ToolRow(data.name, data.arguments, () => false);
        tools.set(data.callId, row);
        add(row);
        return;
      }
      case 'tool/result': {
        const callId = typeof data.message?.toolCallId === 'string' ? data.message.toolCallId : undefined;
        if (callId === undefined) return;
        const row = tools.get(callId);
        const summary = textOfContent(data.message?.content);
        if (row !== undefined) row.finish(summary, data.error !== undefined || data.message?.isError === true);
        else {
          const fallback = new ToolRow('tool', '');
          fallback.finish(summary, data.error !== undefined || data.message?.isError === true);
          add(fallback);
        }
        schedule();
        return;
      }
      case 'turn/start':
        running = true;
        blocked = null;
        cancelAutoExit();
        schedule();
        return;
      case 'turn/end':
        running = false;
        if (live !== null) finalizeLive('');
        if (blocked === null) scheduleAutoExit();
        schedule();
        return;
      case 'session/title':
        if (typeof data.title === 'string' && data.title.trim() !== '') title = data.title;
        schedule();
        return;
      case 'working-directory/change':
        if (typeof data.cwd === 'string' && data.cwd !== '') cwd = data.cwd;
        else if (typeof data.path === 'string' && data.path !== '') cwd = data.path;
        schedule();
        return;
      case 'approval/asked':
        blocked = typeof data.toolName === 'string' ? `${data.toolName} approval` : 'approval';
        cancelAutoExit();
        schedule();
        return;
      case 'approval/decided':
        blocked = null;
        if (!running) scheduleAutoExit();
        schedule();
        return;
      case 'llm/retry':
        addNote(`retrying: ${oneLine(data.reason ?? data.error?.message ?? 'model request failed', 100)}`, 'warn');
        schedule();
        return;
      case 'compaction/start':
        addNote('compacting context…');
        schedule();
        return;
      case 'compaction/end':
        addNote('context compacted');
        schedule();
        return;
      default:
        return;
    }
  };

  const onFrame = (message) => {
    if (String(message.sessionId) !== sessionId) return;
    const frame = message.frame;
    if (frame === null || typeof frame !== 'object') return;
    if (frame.type === 'snapshot') {
      const values = frame.projections?.values ?? {};
      if (typeof values.title === 'string' && values.title.trim() !== '') title = values.title;
      if (typeof frame.header?.cwd === 'string') cwd = frame.header.cwd;
      for (const record of Array.isArray(frame.records) ? frame.records : []) {
        if (record?.type === 'event') handleEvent(record.event);
      }
      if (frame.assistantStream?.activeAttempt !== undefined) {
        running = true;
        cancelAutoExit();
        replayAttempt(frame.assistantStream.activeAttempt);
      } else if (!running && live === null) {
        scheduleAutoExit();
      }
      schedule();
      return;
    }
    if (frame.type === 'event') {
      handleEvent(frame.event);
      return;
    }
    if (frame.type === 'assistant-stream') {
      const inner = frame.frame;
      if (inner?.type === 'start') {
        running = true;
        cancelAutoExit();
        if (live !== null) finalizeLive('');
        ensureLive();
        schedule();
      } else if (inner?.type === 'chunk') {
        const chunk = inner.chunk;
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          running = true;
          cancelAutoExit();
          ensureLive().text += chunk.text;
          schedule();
        }
      }
    }
  };

  const writeScreen = () => {
    try {
      process.stdout.write('\x1b[?1049h\x1b[?25l');
    } catch {
      // no tty
    }
  };
  const restoreScreen = () => {
    try {
      process.stdout.write('\x1b[?2026h\x1b[?25h\x1b[?1049l\x1b[?2026l');
    } catch {
      // no tty
    }
  };

  const wasRaw = process.stdin.isRaw === true;
  const exit = { resolve: null };
  const done = new Promise((resolve) => {
    exit.resolve = resolve;
  });
  const cleanup = () => {
    if (finished) return;
    finished = true;
    clearAutoExit();
    if (renderTimer !== null) clearTimeout(renderTimer);
    process.stdout.off?.('resize', renderNow);
    process.stdin.off?.('data', onInput);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    try {
      if (process.stdin.setRawMode) process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    } catch {
      // ignore
    }
    restoreScreen();
    exit.resolve();
  };
  const onInput = (data) => {
    if (typeof data !== 'string') return;
    if (matchesKey(data, 'ctrl+c') || data === 'q' || data === 'Q') {
      cleanup();
      return;
    }
    const page = Math.max(1, (process.stdout.rows ?? 24) - 3);
    if (matchesKey(data, 'pageup')) {
      scrollBack += page;
      schedule();
    } else if (matchesKey(data, 'pagedown')) {
      scrollBack = Math.max(0, scrollBack - page);
      schedule();
    } else if (matchesKey(data, 'end')) {
      scrollBack = 0;
      schedule();
    }
  };
  const onSignal = () => cleanup();

  try {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onInput);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
    process.stdout.on('resize', renderNow);
  } catch {
    // Keep going; the stream may still be readable.
  }
  writeScreen();
  renderNow();

  const onClose = () => {
    closed = true;
    scheduleAutoExit(Math.min(autoExitMs, 2_000));
    schedule();
  };
  const onSessionError = (message) => {
    if (String(message.sessionId) !== sessionId) return;
    failed = message.error?.message ?? 'session stream failed';
    scheduleAutoExit(Math.min(autoExitMs, 3_000));
    schedule();
  };
  client.on('frame', onFrame);
  client.on('session-error', onSessionError);
  client.on('close', onClose);

  try {
    await client.request('session.open', {
      sessionId,
      ...(parentSessionId === null ? {} : { parentSessionId, mode: 'unknown' }),
    });
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error);
    schedule();
  }

  await done;
  return failed === null && closed === false;
}
