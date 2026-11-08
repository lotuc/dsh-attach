/**
 * Pure helpers for the Host's subagent control routes.
 *
 * DSH exposes continuation and interruption through the `ctx.subagents`
 * runtime; the concrete methods differ across Host generations. These helpers
 * keep capability detection, catalog lookup and row annotation in one place so
 * the server only owns validation and error translation.
 */

/**
 * Which control operations this runtime actually implements.
 *
 * Continuation is a human prompt in current Hosts (`prompt`) or an adjacent
 * Agent message in older/smaller runtimes (`sendMessage`). Interruption is
 * addressed by the durable parent (`interruptByParent`) or by the same user
 * authority on the core primitive (`interrupt`).
 *
 * @param {object|undefined} runtime - `ctx.get('subagents')`
 * @returns {{continue: boolean, interrupt: boolean}}
 */
export function subagentControlCapabilities(runtime) {
  // The control routes resolve the durable direct parent from the catalog, so
  // a runtime without descendant discovery cannot authorize a target even if
  // the execution primitive exists.
  const catalog = typeof runtime?.listDescendants === 'function';
  return {
    continue: catalog && (typeof runtime?.prompt === 'function' || typeof runtime?.sendMessage === 'function'),
    interrupt: catalog && (typeof runtime?.interruptByParent === 'function' || typeof runtime?.interrupt === 'function'),
  };
}

/**
 * Find one child row in a `listDescendants` result by durable id.
 *
 * @param {Array<object>} rows
 * @param {string} childId
 * @returns {object|null}
 */
export function findSubagentRow(rows, childId) {
  const id = String(childId);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.kind === 'child' && String(row.id) === id) return row;
  }
  return null;
}

/**
 * Attach the action availability the picker renders to one mapped catalog row.
 *
 * Continuation requires a continuable mode and a live direct parent (the DSH
 * prompt path authorizes and cold-resumes through that exact parent).
 * Interruption only requires a running activity; the Host accepts a no-op for
 * a target that has already settled.
 *
 * @param {object} row - result of `mapSubagentRow`
 * @param {{continue: boolean, interrupt: boolean}} control
 * @param {boolean} parentActive - whether the row's direct parent is live
 * @returns {object}
 */
export function controlSubagentRow(row, control, parentActive) {
  const mode = row?.mode ?? 'unknown';
  const running = row?.activity === 'running';
  const active = parentActive === true;
  return {
    ...row,
    parentActive: active,
    canContinue: control?.continue === true && mode === 'continuable' && active,
    canInterrupt: control?.interrupt === true && running,
  };
}
