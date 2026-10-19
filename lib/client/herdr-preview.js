/**
 * Helpers for opening read-only subagent previews as Herdr plugin panes.
 *
 * Plugin panes run their manifest command directly (not inside a shell). Herdr
 * removes the pane when that command exits, which lets the preview's idle
 * auto-exit close the pane without an extra `pane close` call.
 */

export const HERDR_PREVIEW_PLUGIN_ID = 'dsh-tui-attach';
export const HERDR_PREVIEW_ENTRYPOINT = 'preview';

/**
 * Build `herdr plugin pane open` arguments for one subagent preview.
 *
 * @param {{
 *   targetPane: string,
 *   direction: 'right'|'down',
 *   sessionId: string,
 *   parentSessionId?: string|null,
 *   profile?: string,
 *   endpoint?: string,
 *   theme?: 'light'|'dark',
 *   dshHome?: string,
 *   exitAfterSeconds?: number|string,
 * }} options
 * @returns {string[]}
 */
export function buildPreviewPaneArgs(options) {
  if (typeof options.sessionId !== 'string' || options.sessionId.trim() === '') {
    throw new Error('sessionId is required');
  }
  const args = [
    'plugin',
    'pane',
    'open',
    '--plugin',
    HERDR_PREVIEW_PLUGIN_ID,
    '--entrypoint',
    HERDR_PREVIEW_ENTRYPOINT,
    '--placement',
    'split',
  ];
  if (typeof options.targetPane === 'string' && options.targetPane !== '') {
    args.push('--target-pane', options.targetPane);
  }
  args.push('--direction', options.direction === 'down' ? 'down' : 'right');

  const env = {
    DSH_PREVIEW_SESSION_ID: options.sessionId,
    DSH_PREVIEW_PARENT_ID: options.parentSessionId ?? '',
    DSH_ATTACH_PROFILE: options.profile ?? '',
    DSH_ATTACH_ENDPOINT: options.endpoint ?? '',
    DSH_ATTACH_THEME: options.theme ?? '',
    DSH_HOME: options.dshHome ?? '',
    DSH_PREVIEW_RUNNING: '1',
    DSH_ATTACH_PREVIEW_EXIT_AFTER: options.exitAfterSeconds ?? '',
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null || String(value) === '') continue;
    args.push('--env', `${key}=${String(value)}`);
  }
  args.push('--no-focus');
  return args;
}

/**
 * Read the pane ID from the JSON printed by `herdr plugin pane open`.
 * @param {string} stdout
 * @returns {string|null}
 */
export function parsePreviewPaneId(stdout) {
  let payload;
  try {
    payload = JSON.parse(String(stdout ?? ''));
  } catch {
    return null;
  }
  return payload?.result?.plugin_pane?.pane?.pane_id
    ?? payload?.result?.pane?.pane_id
    ?? payload?.plugin_pane?.pane?.pane_id
    ?? null;
}
