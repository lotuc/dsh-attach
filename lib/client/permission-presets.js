/** Permission preset values shared by completion and the interactive picker. */
export const PERMISSION_PRESETS = Object.freeze([
  { value: 'read-only', label: 'read-only', description: 'Read-only sandbox' },
  { value: 'workspace-write', label: 'workspace-write', description: 'Write only inside the workspace and temp roots' },
  { value: 'danger-full-access', label: 'danger-full-access', description: 'Disable sandbox confinement; requires confirmation' },
  { value: 'auto', label: 'auto', description: 'Review each tool call with the model before running it' },
]);
