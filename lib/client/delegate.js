/**
 * Build the orchestration prompt for `/delegate`.
 *
 * The client cannot know which parts of the conversation matter, so the main
 * agent writes the brief. This prompt fixes the brief's contract: preserve the
 * user's wording, cite context instead of pasting it, state acceptance, and
 * actually launch a subagent instead of stopping at a plan.
 */

function quote(text) {
  return String(text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * @param {{request: string, cwd?: string, sessionId?: string, title?: string}} input
 * @returns {string}
 */
export function buildDelegatePrompt({ request, cwd = '', sessionId = '', title = '' } = {}) {
  const text = String(request ?? '').trim();
  if (text === '') throw new Error('request is required');
  const context = [];
  if (sessionId !== '') context.push(`- session: ${sessionId}`);
  if (cwd !== '') context.push(`- cwd: ${cwd}`);
  if (title !== '') context.push(`- title: ${title}`);
  const contextBlock = context.length === 0 ? '- (current conversation)' : context.join('\n');
  return `DELEGATION REQUEST

The user gave this short request:
${quote(text)}

Turn it into a self-contained subagent brief using the current conversation and repository context, then actually start a subagent with that brief. Do not stop at printing the brief.

Brief requirements:
- Goal: one observable outcome.
- User request: preserve the original wording above; add interpretation separately.
- Context: relevant paths, line ranges, seq/URLs, current behavior, expected behavior, confirmed decisions, and failed attempts.
- Scope and non-goals: what is explicitly out of scope.
- Constraints: files/directories, tools, permissions, compatibility, and style.
- Assumptions: label each one and say what the subagent should do if it is wrong.
- Acceptance criteria: concrete checks and verification commands.
- Output contract: summary, files changed, tests run, risks, blockers.
- Stop and ask conditions: facts that materially change the result.

Delegation rules:
- Default to a clean-context subagent. Use a forked subagent only when the task genuinely depends on continuing this conversation, not merely on facts that can be cited.
- Keep the brief high-signal. Reference artifacts instead of pasting whole logs or transcripts.
- Do not invent confirmed facts. Mark uncertainty as an assumption.
- If one missing fact materially changes the work, ask me before spawning. Otherwise proceed with explicit assumptions.
- Do not do the delegated implementation yourself while the subagent owns it.
- If a subagent tool is unavailable, say exactly why and return the completed brief instead.

Current context:
${contextBlock}

After spawning, report the child id or name if available, the brief you passed (or a concise summary of it), and what result you expect back.`;
}
