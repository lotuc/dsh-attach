import { spawn, spawnSync } from 'node:child_process';

const SOURCE = 'dsh-tui-attach';
const AGENT = 'dsh';

/**
 * Read the caller context Herdr injects into every managed pane. Outside a
 * Herdr pane this returns null and every report becomes a no-op.
 * @param {NodeJS.ProcessEnv} env
 */
export function herdrContext(env = process.env) {
  if (env.HERDR_ENV !== '1') return null;
  const pane = typeof env.HERDR_PANE_ID === 'string' ? env.HERDR_PANE_ID : '';
  const bin = typeof env.HERDR_BIN_PATH === 'string' ? env.HERDR_BIN_PATH : '';
  if (pane === '' || bin === '') return null;
  return { pane, bin, socket: env.HERDR_SOCKET_PATH ?? null };
}


/**
 * The Herdr facts worth passing to model shell commands.
 * Only inject them when this process is actually inside a managed Herdr pane.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, string>}
 */
export function herdrEnvironment(env = process.env) {
  if (herdrContext(env) === null) return {};
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('HERDR_') || typeof value !== 'string' || value === '') continue;
    result[key] = value;
  }
  return result;
}

/**
 * Build `herdr pane report-agent` arguments. The resume command is attached
 * after `--` and must start with a plain command name on PATH.
 */
export function herdrReportArgs(context, state, { seq, message, sessionId, resume } = {}) {
  const args = [
    'pane',
    'report-agent',
    context.pane,
    '--source',
    SOURCE,
    '--agent',
    AGENT,
    '--state',
    state,
    '--seq',
    String(seq),
  ];
  if (typeof message === 'string' && message.trim() !== '') args.push('--message', message.trim());
  if (typeof sessionId === 'string' && sessionId !== '') args.push('--agent-session-id', sessionId);
  if (Array.isArray(resume) && resume.length > 0) args.push('--', ...resume);
  return args;
}

/**
 * Build `herdr pane report-metadata` arguments for the visible pane title and
 * agent display name. These are presentation-only; lifecycle state continues
 * to come from `pane report-agent`.
 */
export function herdrReportMetadataArgs(context, { seq, title, displayAgent, clear = false } = {}) {
  const args = [
    'pane',
    'report-metadata',
    context.pane,
    '--source',
    SOURCE,
    '--agent',
    AGENT,
    '--seq',
    String(seq),
  ];
  if (clear) {
    args.push('--clear-title', '--clear-display-agent');
  } else {
    if (typeof title === 'string' && title !== '') args.push('--title', title);
    if (typeof displayAgent === 'string' && displayAgent !== '') args.push('--display-agent', displayAgent);
  }
  return args;
}

/**
 * Best-effort Herdr lifecycle reporter. Reports are detached and failures are
 * ignored: Herdr must never slow down or block the TUI.
 */
export class HerdrReporter {
  #context;
  #spawn;
  #spawnSync;
  #now;
  #seq = 0;
  #lastState = null;
  #lastMessage = null;
  #lastSession = null;
  #lastTitle = null;
  #released = false;

  constructor(env = process.env, { spawn: spawnImpl = spawn, spawnSync: spawnSyncImpl = spawnSync, now = Date.now } = {}) {
    this.#context = herdrContext(env);
    this.#spawn = spawnImpl;
    this.#spawnSync = spawnSyncImpl;
    this.#now = now;
  }

  get active() {
    return this.#context !== null;
  }

  get pane() {
    return this.#context?.pane ?? null;
  }

  #nextSeq() {
    this.#seq = Math.max(this.#now(), this.#seq + 1);
    return this.#seq;
  }

  /**
   * Report one semantic state. Repeated identical states (and blocked
   * messages) are dropped; a session change also refreshes the resume command.
   */
  report(state, { message, sessionId, resume } = {}) {
    if (this.#context === null || this.#released) return false;
    const normalizedMessage = typeof message === 'string' && message.trim() !== '' ? message.trim() : null;
    const sessionChanged = typeof sessionId === 'string' && sessionId !== this.#lastSession;
    if (state === this.#lastState && normalizedMessage === this.#lastMessage && !sessionChanged) return false;
    this.#lastState = state;
    this.#lastMessage = normalizedMessage;
    if (typeof sessionId === 'string') this.#lastSession = sessionId;
    const args = herdrReportArgs(this.#context, state, {
      seq: this.#nextSeq(),
      message: normalizedMessage ?? undefined,
      sessionId,
      resume: sessionChanged ? resume : undefined,
    });
    this.#run(args);
    return true;
  }

  /**
   * Report the session title as the pane title and visible agent name. Herdr
   * caps both at 80 characters; dedupe so title changes are the only writes.
   */
  reportTitle(title) {
    if (this.#context === null || this.#released) return false;
    const normalized = typeof title === 'string'
      ? title.replace(/\s+/gu, ' ').trim().slice(0, 80)
      : '';
    if (normalized === '') {
      if (this.#lastTitle === null) return false;
      this.#lastTitle = null;
      this.#run(herdrReportMetadataArgs(this.#context, { seq: this.#nextSeq(), clear: true }));
      return true;
    }
    if (normalized === this.#lastTitle) return false;
    this.#lastTitle = normalized;
    this.#run(herdrReportMetadataArgs(this.#context, {
      seq: this.#nextSeq(),
      title: normalized,
      displayAgent: normalized,
    }));
    return true;
  }

  /** Release this pane when the user actually quits the TUI. */
  release() {
    if (this.#context === null || this.#released) return false;
    this.#released = true;
    if (this.#lastTitle !== null) {
      const args = herdrReportMetadataArgs(this.#context, { seq: this.#nextSeq(), clear: true });
      try {
        this.#spawnSync(this.#context.bin, args, { stdio: 'ignore', timeout: 1_000 });
      } catch {
        // Best effort only.
      }
      this.#lastTitle = null;
    }
    const args = [
      'pane',
      'release-agent',
      this.#context.pane,
      '--source',
      SOURCE,
      '--agent',
      AGENT,
      '--seq',
      String(this.#nextSeq()),
    ];
    try {
      this.#spawnSync(this.#context.bin, args, { stdio: 'ignore', timeout: 1_000 });
    } catch {
      // Herdr may already be gone; nothing to release.
    }
    return true;
  }

  #run(args) {
    try {
      const child = this.#spawn(this.#context.bin, args, { stdio: 'ignore', detached: true });
      child.on?.('error', () => {});
      child.unref?.();
      const timer = setTimeout(() => {
        try {
          child.kill?.();
        } catch {
          // already exited
        }
      }, 1_500);
      timer.unref?.();
    } catch {
      // Best effort only.
    }
  }
}
