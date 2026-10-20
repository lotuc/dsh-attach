/**
 * Read-only background-job helpers shared by the TUI and its tests.
 *
 * The Host exposes `job.list` rows and non-consuming `job.read` output. These
 * helpers only shape that data; they never touch the model's job cursor.
 */
import { oneLine } from './transcript.js';

const LIVE = new Set(['running', 'stopping']);

/** Whether a job is still running or stopping. */
export function jobIsLive(job) {
  return LIVE.has(job?.status);
}

/** Compact elapsed time for a job row. */
export function formatJobDuration(ms) {
  const total = Number(ms);
  if (!Number.isFinite(total) || total <= 0) return '0s';
  const seconds = Math.max(0, Math.round(total / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, '0')}h`;
}

/**
 * Turn job views into FilterList rows: live jobs first, then newest settled.
 * @param {Array<object>} jobs
 * @param {number} [now]
 * @returns {Array<object>}
 */
export function jobItems(jobs, now = Date.now()) {
  const rows = Array.isArray(jobs) ? jobs.filter((job) => job !== null && typeof job === 'object') : [];
  return [...rows]
    .sort((left, right) => {
      const liveLeft = jobIsLive(left);
      const liveRight = jobIsLive(right);
      if (liveLeft !== liveRight) return liveLeft ? -1 : 1;
      const leftAt = Number(left.finishedAt ?? left.startedAt) || 0;
      const rightAt = Number(right.finishedAt ?? right.startedAt) || 0;
      return rightAt - leftAt;
    })
    .map((job) => {
      const live = jobIsLive(job);
      const started = Number(job.startedAt) || now;
      const elapsed = formatJobDuration((Number(job.finishedAt) || now) - started);
      const detail = typeof job.progress === 'string' && job.progress.trim() !== ''
        ? job.progress
        : typeof job.detail === 'string'
          ? job.detail
          : '';
      return {
        value: String(job.id),
        label: `${live ? '●' : '○'} ${oneLine(String(job.kind ?? 'job'), 24)} · ${oneLine(String(job.label ?? '(unlabeled)'), 56)}`,
        description: `${String(job.id ?? '')}${detail === '' ? '' : ` · ${oneLine(detail, 80)}`}`,
        meta: `${job.status ?? 'unknown'} ${elapsed}`,
        job,
        running: live,
      };
    });
}

/** Number of live jobs in a roster. */
export function runningJobCount(jobs) {
  return (Array.isArray(jobs) ? jobs : []).filter((job) => jobIsLive(job)).length;
}

/**
 * Fold one durable `job/registered` or `job/settled` event into a roster map.
 * @param {Map<string, object>} roster
 * @param {string} type
 * @param {object} data
 * @returns {Map<string, object>}
 */
export function mergeJobEvent(roster, type, data) {
  if (data === null || typeof data !== 'object') return roster;
  const id = typeof data.jobId === 'string' ? data.jobId : '';
  if (id === '') return roster;
  const next = new Map(roster);
  if (type === 'job/registered') {
    next.set(id, {
      id,
      kind: typeof data.kind === 'string' ? data.kind : 'job',
      label: typeof data.label === 'string' ? data.label : '',
      owner: typeof data.owner === 'string' ? data.owner : undefined,
      status: 'running',
      startedAt: Number(data.startedAt) || 0,
      output: { total: 0, earliest: 0 },
    });
  } else if (type === 'job/settled') {
    const previous = next.get(id) ?? {};
    next.set(id, {
      ...previous,
      id,
      kind: typeof data.kind === 'string' ? data.kind : previous.kind ?? 'job',
      label: typeof data.label === 'string' ? data.label : previous.label ?? '',
      owner: typeof data.owner === 'string' ? data.owner : previous.owner,
      status: typeof data.status === 'string' ? data.status : 'completed',
      startedAt: Number(data.startedAt) || previous.startedAt || 0,
      finishedAt: Number(data.finishedAt) || 0,
      ...(typeof data.detail === 'string' && data.detail !== '' ? { detail: data.detail } : {}),
      output: previous.output ?? { total: 0, earliest: 0 },
    });
  }
  return next;
}
