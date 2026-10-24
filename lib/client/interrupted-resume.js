/** A Host restart can leave the last turn closed as interrupted. */
export const INTERRUPTED_RESUME_PROMPT = 'The previous turn was interrupted by a Host restart. Continue from where it stopped. Do not repeat completed work; inspect the current state first if needed.';

/** Only resume once, and never while another turn or queued input is active. */
export function shouldResumeInterrupted({
  reason,
  running = false,
  subagent = false,
  pending = 0,
  attempted = false,
  enabled = true,
} = {}) {
  return enabled === true && reason === 'interrupted' && running !== true && subagent !== true && pending === 0 && attempted !== true;
}

/** Stable idempotency key shared by every TUI reconnecting to the same turn. */
export function interruptedResumeRequestId(sessionId, turn) {
  return `attach-resume-${String(sessionId ?? '')}-${Number(turn) || 0}`;
}
