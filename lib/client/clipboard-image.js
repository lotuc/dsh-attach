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
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$image = [System.Windows.Forms.Clipboard]::GetImage()',
      "if ($null -eq $image) { throw 'clipboard does not contain an image' }",
      '$stream = New-Object System.IO.MemoryStream',
      '$image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)',
      '[Convert]::ToBase64String($stream.ToArray())',
    ].join('; ');
    try {
      const result = await run('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { maxBuffer: MAX_BUFFER });
      return imageFromBase64(result?.stdout ?? result);
    } catch {
      throw new Error('clipboard does not contain an image');
    }
  }
  throw new Error('clipboard image reading is supported on macOS, Linux and Windows only');
}

/**
 * Read clipboard text as a fallback for a native paste shortcut.
 * Returns an empty string when no text clipboard is available.
 */
export async function readClipboardText({ platform = process.platform, run = execFile } = {}) {
  const maxBuffer = 8 * 1024 * 1024;
  if (platform === 'darwin') {
    try {
      const result = await run('pbpaste', [], { maxBuffer });
      return String(result?.stdout ?? result ?? '');
    } catch {
      return '';
    }
  }
  if (platform === 'linux') {
    for (const [command, args] of [
      ['wl-paste', ['--no-newline']],
      ['xclip', ['-selection', 'clipboard', '-o']],
    ]) {
      try {
        const result = await run(command, args, { maxBuffer });
        return String(result?.stdout ?? result ?? '');
      } catch {
        // Try the next clipboard implementation.
      }
    }
    return '';
  }
  if (platform === 'win32') {
    try {
      const result = await run('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { maxBuffer });
      return String(result?.stdout ?? result ?? '');
    } catch {
      return '';
    }
  }
  return '';
}
