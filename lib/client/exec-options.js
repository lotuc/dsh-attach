/**
 * Validation shared by `--exec` flags and the headless runner.
 *
 * The CLI rejects bad flags before connecting; `runExec` repeats the same
 * checks so a programmatic caller gets the same clear error instead of a Host
 * round-trip that can only fail later.
 */
import { PERMISSION_PRESETS } from './permission-presets.js';

/** Whether `value` is one of the permission presets the Host exposes. */
export function isPermissionPreset(value) {
  return PERMISSION_PRESETS.some((preset) => preset.value === value);
}

/** The accepted `--permission` values, in display order. */
export function permissionPresetValues() {
  return PERMISSION_PRESETS.map((preset) => preset.value);
}

/**
 * Parse `provider/model` into a model selection.
 *
 * Only the first slash separates provider and model, so providers whose model
 * ids contain a slash (for example OpenRouter) keep the full model id.
 *
 * @param {unknown} value
 * @returns {{provider: string, model: string}|null}
 */
export function parseModelSelection(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const separator = text.indexOf('/');
  if (separator <= 0 || separator === text.length - 1) return null;
  const provider = text.slice(0, separator).trim();
  const model = text.slice(separator + 1).trim();
  if (provider === '' || model === '') return null;
  return { provider, model };
}
