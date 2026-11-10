import { homedir } from 'node:os';

/** Human-readable age for a session or job timestamp. */
export function formatAge(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Shorten a cwd, replacing the home prefix with `~` and the head with `…`. */
export function shortCwd(cwd, max, home = homedir()) {
  if (typeof cwd !== 'string' || cwd === '') return '';
  let value = cwd;
  if (typeof home === 'string' && home !== '' && (cwd === home || cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`))) {
    value = `~${cwd.slice(home.length)}`;
  }
  if (value.length <= max) return value;
  return `…${value.slice(Math.max(0, value.length - max + 1))}`;
}

/** Compact elapsed duration for live status and completed turns. */
export function formatDuration(milliseconds) {
  const ms = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  if (ms < 1_000) return '<1s';
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Local wall-clock time; include the date when it is not today. */
export function formatClock(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const date = new Date(timestamp);
  const today = new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  if (date.toDateString() === today.toDateString()) return time;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}
