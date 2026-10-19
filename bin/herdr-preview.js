#!/usr/bin/env node
/**
 * Herdr plugin pane entrypoint for a read-only DSH subagent preview.
 *
 * Herdr runs this as the pane's command (no shell), so when `main()` returns
 * Herdr closes the pane. The parent TUI supplies the session IDs and connection
 * overrides through `herdr plugin pane open --env ...`.
 */
import { main } from '../lib/client/cli.js';

const read = (name) => {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
};

const sessionId = read('DSH_PREVIEW_SESSION_ID');
if (sessionId === '') {
  console.error('herdr-preview: DSH_PREVIEW_SESSION_ID is required');
  process.exitCode = 2;
} else {
  const argv = ['--preview', sessionId];
  const parentSessionId = read('DSH_PREVIEW_PARENT_ID');
  if (parentSessionId !== '') argv.push('--parent', parentSessionId);

  const profile = read('DSH_ATTACH_PROFILE');
  if (profile !== '') argv.push('--profile', profile);
  const endpoint = read('DSH_ATTACH_ENDPOINT');
  if (endpoint !== '') argv.push('--endpoint', endpoint);
  const theme = read('DSH_ATTACH_THEME');
  if (theme !== '') argv.push('--theme', theme);
  if (read('DSH_PREVIEW_RUNNING') === '1') argv.push('--preview-running');
  const exitAfter = read('DSH_ATTACH_PREVIEW_EXIT_AFTER');
  if (exitAfter !== '') argv.push('--preview-exit-after', exitAfter);

  await main(argv);
}
