import { spawnSync } from 'node:child_process';

/**
 * Copy plain text through the platform clipboard command.
 * @param {string} text
 * @param {{platform?: NodeJS.Platform, spawnSync?: typeof spawnSync}} [options]
 * @returns {boolean}
 */
export function copyToClipboard(text, { platform = process.platform, spawnSync: run = spawnSync } = {}) {
  if (typeof text !== 'string' || text === '') return false;
  const candidates = platform === 'darwin'
    ? [['pbcopy', []]]
    : platform === 'win32'
      ? [['clip', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [command, args] of candidates) {
    try {
      const result = run(command, args, { input: text, encoding: 'utf8', timeout: 3_000 });
      if (result.status === 0) return true;
    } catch {
      // Try the next platform clipboard helper.
    }
  }
  return false;
}
