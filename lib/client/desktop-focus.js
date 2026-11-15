import { spawnSync } from 'node:child_process';

const APP_NAME = 'DeepSeek Harness';
const OPEN_URL = 'dsh://open';

/**
 * Build the AppleScript that opens DSH, invokes its session search, types the
 * current session title and opens the first match.
 *
 * This is deliberately best-effort: the DSH desktop shell only understands
 * `dsh://open`, so selecting a session requires the app's own search UI.
 */
export function buildDesktopFocusScript() {
  return [
    'on run argv',
    `  tell application ${JSON.stringify(APP_NAME)} to activate`,
    '  delay 0.35',
    '  tell application "System Events"',
    '    keystroke "k" using command down',
    '    delay 0.15',
    '    keystroke (item 1 of argv)',
    '    delay 0.35',
    '    key code 36',
    '  end tell',
    'end run',
  ].join('\n');
}

/**
 * Focus the DSH desktop window and select the current session by title.
 * @param {{title?: string, sessionId?: string, platform?: NodeJS.Platform, spawnSync?: typeof spawnSync}} options
 * @returns {{ok: boolean, selected: boolean, reason?: string}}
 */
export function focusDesktopSession({ title, sessionId, platform = process.platform, spawnSync: run = spawnSync } = {}) {
  if (platform !== 'darwin') {
    return { ok: false, selected: false, reason: `desktop focus is not implemented on ${platform}` };
  }
  const query = String(title ?? '').trim() || String(sessionId ?? '').trim();
  if (query === '') return { ok: false, selected: false, reason: 'session title is empty' };

  const opened = run('open', [OPEN_URL], { encoding: 'utf8', timeout: 5_000 });
  if (opened.status !== 0) {
    return { ok: false, selected: false, reason: (opened.stderr || 'could not open DSH').trim() };
  }

  const result = run('osascript', ['-e', buildDesktopFocusScript(), query], { encoding: 'utf8', timeout: 8_000 });
  if (result.status === 0) return { ok: true, selected: true };
  const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
  return {
    ok: false,
    selected: false,
    reason: /assistive|accessibility|not allowed/iu.test(detail)
      ? 'grant Accessibility permission to this terminal, then retry'
      : detail || 'could not focus the DSH session',
  };
}
