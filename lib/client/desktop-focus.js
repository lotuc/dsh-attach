import { spawnSync } from 'node:child_process';

import { writeFocusRequest } from '../host/focus-bridge.js';

const OPEN_URL = 'dsh://open';

/**
 * Ask DSH Desktop to focus the current session.
 *
 * The session id goes through the loopback focus bridge consumed by the
 * dsh-attach Web client half; `dsh://open` is only the window-raise step.
 * @param {{sessionId?: string, home?: string, spawnSync?: typeof spawnSync}} options
 * @returns {{ok: boolean, requested: boolean, reason?: string}}
 */
export function focusDesktopSession({ sessionId, home, spawnSync: run = spawnSync } = {}) {
  const id = String(sessionId ?? '').trim();
  if (id === '') return { ok: false, requested: false, reason: 'no session is open' };
  try {
    writeFocusRequest(id, home === undefined ? {} : { home });
  } catch (error) {
    return { ok: false, requested: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const opened = run('open', [OPEN_URL], { encoding: 'utf8', timeout: 5_000 });
  if (opened.status !== 0) {
    return { ok: false, requested: false, reason: (opened.stderr || 'could not open DSH').trim() };
  }
  return { ok: true, requested: true };
}
