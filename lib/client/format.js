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
export function shortCwd(cwd, max, home = process.env.HOME) {
  if (typeof cwd !== 'string' || cwd === '') return '';
  let value = cwd;
  if (typeof home === 'string' && home !== '' && (cwd === home || cwd.startsWith(`${home}/`))) {
    value = `~${cwd.slice(home.length)}`;
  }
  if (value.length <= max) return value;
  return `…${value.slice(Math.max(0, value.length - max + 1))}`;
}
