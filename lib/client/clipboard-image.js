import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MAX_BUFFER = 32 * 1024 * 1024;

function imageFromBase64(data) {
  const value = String(data ?? '').trim();
  if (value === '') throw new Error('clipboard does not contain an image');
  return { mediaType: 'image/png', data: value, name: 'clipboard.png' };
}

/**
 * Read an image from the system clipboard. macOS uses pngpaste when present,
 * then falls back to AppleScript; Linux supports wl-paste and xclip.
 */
export async function readClipboardImage({
  platform = process.platform,
  run = execFile,
  readFileFn = readFile,
  rmFn = rm,
} = {}) {
  if (platform === 'darwin') {
    try {
      const result = await run('pngpaste', ['-b'], { maxBuffer: MAX_BUFFER });
      return imageFromBase64(result?.stdout ?? result);
    } catch {
      // pngpaste is optional; AppleScript is available on stock macOS.
    }
    const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-clipboard-'));
    const file = join(dir, 'clipboard.png');
    try {
      const script = [
        `set theFile to (open for access (POSIX file ${JSON.stringify(file)}) with write permission)`,
        'set eof theFile to 0',
        'write (the clipboard as «class PNGf») to theFile',
        'close access theFile',
      ].join('\n');
      await run('osascript', ['-e', script], { maxBuffer: MAX_BUFFER });
      const bytes = await readFileFn(file);
      return imageFromBase64(Buffer.from(bytes).toString('base64'));
    } finally {
      await rmFn(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (platform === 'linux') {
    const commands = [
      ['wl-paste', ['--no-newline', '--type', 'image/png']],
      ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
    ];
    for (const [command, args] of commands) {
      try {
        const result = await run(command, args, { encoding: 'buffer', maxBuffer: MAX_BUFFER });
        const bytes = Buffer.from(result?.stdout ?? result);
        if (bytes.length > 0) {
          return { mediaType: 'image/png', data: bytes.toString('base64'), name: 'clipboard.png' };
        }
      } catch {
        // Try the next clipboard implementation.
      }
    }
  }
  throw new Error('clipboard image reading is supported on macOS and Linux only');
}
