/** Plan-mode command parsing and status rendering for the attach TUI. */

/**
 * Parse the TUI's `/plan` grammar.
 *
 * DSH supports bare `/plan` (enter), `/plan off` (leave), and `/plan <message>`
 * (enter with an instruction). `status` is a local read-only addition; `exit`
 * and `on` are convenience aliases.
 */
export function parsePlanCommand(rawInput) {
  const input = String(rawInput ?? '').trim();
  if (input === '') return { kind: 'enter' };
  const control = input.toLowerCase();
  if (control === 'status' || control === 'show') return { kind: 'status' };
  if (control === 'off' || control === 'exit') return { kind: 'exit' };
  if (control === 'enter' || control === 'on') return { kind: 'enter' };
  if (control === 'approve') return { kind: 'approve' };
  const enter = /^enter\s+([\s\S]*)$/iu.exec(input);
  if (enter !== null) return { kind: 'message', message: enter[1].trim() };
  return { kind: 'message', message: input };
}

/** Translate one local plan action into its Host command line. */
export function planHostLine(command) {
  switch (command?.kind) {
    case 'enter': return '/plan';
    case 'exit': return '/plan off';
    case 'message': return `/plan ${command.message}`;
    default: return null;
  }
}

/**
 * Detailed lines for the `/plan` status panel.
 * @param {{active?: boolean, pending?: boolean}|null} plan
 * @param {{review?: boolean}} [options]
 */
export function planStatusLines(plan, { review = false } = {}) {
  const active = plan?.active === true;
  const pending = plan?.pending === true;
  const lines = [`mode       ${active ? 'active' : 'inactive'}`];
  if (pending) lines.push('pending    a mode change applies from the next step');
  if (review) lines.push('review     a plan is waiting for approval in the question panel');
  lines.push('', `commands   ${active ? '/plan off' : '/plan or /plan <message>'}`);
  lines.push(
    '',
    active
      ? 'Approve or keep planning in the plan-review panel when the model presents a plan.'
      : 'Enter with a message to start planning, for example /plan inspect the failing tests.',
  );
  return lines;
}
