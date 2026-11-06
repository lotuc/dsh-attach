/**
 * Optional development supervisor for the terminal client.
 *
 * Node cannot hot-swap the running TUI's classes safely, so `--hot` watches
 * the client/shared modules and restarts the child process in place. The Host
 * and session keep running; the restarted child reconnects and reopens the
 * requested session. This is intentionally opt-in.
 */
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';

const WATCH_DIRS = ['bin', 'lib/client', 'lib/shared'];
const DEBOUNCE_MS = 180;

/** Remove the supervisor-only flag before spawning the TUI child. */
export function hotChildArgs(argv) {
  return argv.filter((arg) => arg !== '--hot');
}

/** Only source files should trigger a restart. */
export function isHotSource(filename) {
  return typeof filename === 'string' && (filename.endsWith('.js') || filename.endsWith('.mjs'));
}

function watchSources(root, onChange, watchFn = watch) {
  const watchers = [];
  for (const relative of WATCH_DIRS) {
    try {
      const watcher = watchFn(join(root, relative), (event, filename) => {
        if (isHotSource(filename)) onChange();
      });
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch {
      // A missing optional directory is fine.
    }
  }
  return () => {
    for (const watcher of watchers) watcher.close();
  };
}

/**
 * Run a child TUI and restart it when client/shared sources change.
 * @param {{root: string, argv: string[], spawnFn?: typeof spawn, watchFn?: Function, log?: (message: string) => void}} options
 * @returns {Promise<number>} child exit code
 */
export async function runHotReload({ root, argv, spawnFn = spawn, watchFn = watch, log = console.error }) {
  const entry = join(root, 'bin', 'dsh-attach.js');
  let child = null;
  let stopping = false;
  let finished = false;
  let restarting = false;
  let timer = null;
  let resolveExit;
  const exit = new Promise((resolve) => { resolveExit = resolve; });

  const closeWatchers = watchSources(root, () => {
    if (stopping) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      restart();
    }, DEBOUNCE_MS);
  }, watchFn);

  const shutdown = (code) => {
    if (finished) return;
    finished = true;
    stopping = true;
    if (timer !== null) clearTimeout(timer);
    closeWatchers();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    resolveExit(code);
  };

  const onSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    if (timer !== null) clearTimeout(timer);
    closeWatchers();
    if (child !== null && !child.killed) child.kill(signal);
    else shutdown(signal === 'SIGINT' ? 130 : 143);
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
  };

  const start = () => {
    if (stopping) return;
    child = spawnFn(process.execPath, [entry, ...hotChildArgs(argv)], {
      cwd: process.cwd(),
      env: { ...process.env, DSH_ATTACH_HOT: '0' },
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      log(`hot reload: cannot start client: ${error instanceof Error ? error.message : String(error)}`);
    });
    child.on('exit', (code, signal) => {
      if (stopping) {
        shutdown(code ?? (signal === 'SIGINT' ? 130 : 1));
        return;
      }
      if (restarting) {
        restarting = false;
        start();
        return;
      }
      if (code === 0) {
        shutdown(0);
        return;
      }
      child = null;
      log(`hot reload: client exited (${code ?? signal}); waiting for a source change`);
    });
  };

  const restart = () => {
    if (stopping) return;
    if (child === null) {
      start();
      return;
    }
    if (restarting) return;
    restarting = true;
    child.kill('SIGTERM');
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  start();
  const code = await exit;
  process.exitCode = code;
  return code;
}
