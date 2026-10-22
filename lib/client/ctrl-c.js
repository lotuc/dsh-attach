/** Decide whether a Ctrl+C press should quit immediately or arm a confirmation. */
export function ctrlCAction({ running, overlay, armedAt, now = Date.now(), windowMs = 2_000 }) {
  if (armedAt !== null && Number.isFinite(armedAt) && now - armedAt <= windowMs) return 'quit';
  if (!running && !overlay) return 'quit';
  return 'arm';
}
