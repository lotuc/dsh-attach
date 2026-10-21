/**
 * Place the floating completion list above the editor.
 *
 * Kept separate from AttachApp so the screen geometry has a small, testable
 * pure function. Missing panel heights are treated as zero so a closed panel
 * cannot take down input handling.
 */
export function autocompleteRow({
  rows,
  editorHeight,
  footerHeight,
  activityHeight,
  queueHeight,
  peekHeight,
  lineCount,
}) {
  const height = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  const occupied = height(footerHeight)
    + height(editorHeight)
    + height(activityHeight)
    + height(queueHeight)
    + height(peekHeight)
    + height(lineCount);
  return Math.max(1, height(rows) - occupied);
}
