/**
 * Client-side subagent control vocabulary.
 *
 * Capability is advertised by the Host per route, while the catalog row carries
 * whether a specific child can be continued or stopped. Keeping the wording in
 * one module makes the picker, `/subagent` commands, and `/cancel` agree on
 * availability and failure text.
 */

/** Capabilities required from the Host for each control operation. */
export const SUBAGENT_CONTROL_CAPABILITY = Object.freeze({
  continue: 'subagent.continue',
  interrupt: 'subagent.interrupt',
});

/**
 * Read the Host's advertised subagent control capabilities.
 *
 * @param {{capabilities?: string[]}|null|undefined} host
 * @returns {{continue: boolean, interrupt: boolean}}
 */
export function subagentControlCapabilities(host) {
  const advertised = new Set(Array.isArray(host?.capabilities) ? host.capabilities : []);
  return {
    continue: advertised.has(SUBAGENT_CONTROL_CAPABILITY.continue),
    interrupt: advertised.has(SUBAGENT_CONTROL_CAPABILITY.interrupt),
  };
}

/** Host-side failure codes translated for the terminal. */
const CONTROL_ERROR_TEXT = Object.freeze({
  'subagent/parent-unavailable': 'the subagent parent is not live; open the parent session first',
  'subagent/not-resumable': 'only continuable subagents can be continued',
  'subagent/unauthorized': 'the Host does not authorize this subagent control request',
  'subagent/delivery-unavailable': 'the subagent cannot accept a message right now',
  'subagent/control-unavailable': 'this Host cannot read the subagent catalog',
  'gateway/cancelled': 'the subagent control request was cancelled',
  'attach/not-found': 'that subagent is not in the current session lineage',
  'attach/no-session': 'no session is open',
});

/**
 * Turn one Host failure into a concise terminal message.
 *
 * @param {unknown} error
 * @param {string} [action] - verb for the fallback text
 * @returns {string}
 */
export function subagentControlErrorText(error, action = 'subagent control') {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (CONTROL_ERROR_TEXT[code] !== undefined) return CONTROL_ERROR_TEXT[code];
  const message = error instanceof Error ? error.message : String(error);
  return `${action} failed: ${message === '' ? 'unknown error' : message}`;
}

/**
 * Why one action is unavailable for a picker row.
 *
 * @param {{mode?: string, parentActive?: boolean, canContinue?: boolean, canInterrupt?: boolean, running?: boolean}} item
 * @param {'continue'|'interrupt'} action
 * @param {{continue: boolean, interrupt: boolean}} [hostControl]
 * @returns {string|null} null when the action is available
 */
export function subagentControlUnavailable(item, action, hostControl = { continue: false, interrupt: false }) {
  if (action === 'continue') {
    if (item?.canContinue === true) return null;
    if (hostControl.continue !== true) return 'this Host does not expose subagent continuation';
    if (item?.mode !== 'continuable') return 'only continuable subagents can be continued';
    if (item?.parentActive === false) return 'the subagent parent is not live; open the parent session first';
    return 'this subagent cannot accept a follow-up right now';
  }
  if (item?.canInterrupt === true) return null;
  if (hostControl.interrupt !== true) return 'this Host does not expose subagent interruption';
  if (item?.running !== true) return 'that subagent is not running';
  return 'this subagent cannot be stopped right now';
}

/**
 * Footer hint for the picker's available actions.
 *
 * @param {Array<{canContinue?: boolean, canInterrupt?: boolean}>} items
 * @returns {string}
 */
export function subagentControlHint(items) {
  const list = Array.isArray(items) ? items : [];
  const parts = [];
  if (list.some((item) => item?.canContinue === true)) parts.push('c continue');
  if (list.some((item) => item?.canInterrupt === true)) parts.push('x stop');
  return parts.join(' · ');
}
