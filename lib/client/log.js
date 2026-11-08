import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ENDPOINT_DIR } from '../shared/protocol.js';

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Resolve the lifecycle log path; `DSH_ATTACH_LOG=off` disables it. */
export function resolveLogPath(env = process.env) {
  if (env.DSH_ATTACH_LOG === 'off') return null;
  if (typeof env.DSH_ATTACH_LOG === 'string' && env.DSH_ATTACH_LOG.trim() !== '') return env.DSH_ATTACH_LOG.trim();
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return join(home, ENDPOINT_DIR, 'client.log');
}

function redactArgv(argv) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--token') {
      out.push('--token', '<redacted>');
      index += 1;
    } else {
      out.push(argv[index]);
    }
  }
  return out;
}

/** Append-only, 0600 lifecycle log. Never logs prompt text. */
export class ClientLog {
  #file;
  #now;
  #prepared = false;
  #bytes = 0;
  #throttle = new Map();

  constructor(file = resolveLogPath(), { now = Date.now } = {}) {
    this.#file = file;
    this.#now = now;
  }

  get path() {
    return this.#file;
  }

  #prepare() {
    if (this.#prepared) return true;
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    } catch {
      return false;
    }
    try {
      const size = statSync(this.#file).size;
      if (size > MAX_LOG_BYTES) {
        try {
          renameSync(this.#file, `${this.#file}.1`);
        } catch {
          // Keep appending if rotation fails.
        }
        this.#bytes = 0;
      } else {
        this.#bytes = size;
      }
      chmodSync(this.#file, 0o600);
    } catch {
      this.#bytes = 0;
    }
    this.#prepared = true;
    return true;
  }

  event(name, data = {}) {
    if (this.#file === null) return;
    if (!this.#prepare()) return;
    let payload;
    try {
      payload = JSON.stringify(data);
    } catch {
      payload = '{}';
    }
    const line = `${new Date().toISOString()} pid=${process.pid} ${name} ${payload}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    try {
      if (this.#bytes + bytes > MAX_LOG_BYTES) {
        try {
          renameSync(this.#file, `${this.#file}.1`);
        } catch {
          // Keep appending if another writer/rotation raced us.
        }
        this.#bytes = 0;
      }
      appendFileSync(this.#file, line, { mode: 0o600 });
      this.#bytes += bytes;
    } catch {
      // Diagnostics must never break the UI.
    }
  }

  /**
   * Log at most once per interval for a noisy source (focus in/out). The next
   * accepted event carries the number of events suppressed in between.
   */
  throttled(name, intervalMs, data = {}, key = name) {
    const now = this.#now();
    let record = this.#throttle.get(key);
    if (record === undefined) {
      record = { at: 0, suppressed: 0 };
      this.#throttle.set(key, record);
    }
    if (record.at !== 0 && now - record.at < intervalMs) {
      record.suppressed += 1;
      return false;
    }
    const suppressed = record.suppressed;
    record.at = now;
    record.suppressed = 0;
    this.event(name, suppressed > 0 ? { ...data, suppressed } : data);
    return true;
  }

  start(argv = process.argv.slice(2)) {
    this.event('start', {
      version: process.env.DSH_ATTACH_VERSION ?? null,
      argv: redactArgv(argv),
      term: process.env.TERM ?? null,
      termProgram: process.env.TERM_PROGRAM ?? null,
      tmux: process.env.TMUX ?? null,
      herdr: process.env.HERDR_ENV ?? null,
      herdrWorkspace: process.env.HERDR_WORKSPACE_ID ?? null,
      herdrTab: process.env.HERDR_TAB_ID ?? null,
      herdrPane: process.env.HERDR_PANE_ID ?? null,
      ssh: process.env.SSH_TTY ?? null,
      tty: process.stdout.isTTY === true,
      columns: process.stdout.columns ?? null,
      rows: process.stdout.rows ?? null,
    });
  }
}
