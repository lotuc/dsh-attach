/**
 * Editor with the built-in autocomplete list moved out of its layout height.
 *
 * pi-tui renders the suggestion list below the composer, which makes the
 * composer's total height grow and pushes the input up. This subclass keeps the
 * editor height stable and exposes the rendered suggestion block so the app can
 * draw it as a non-capturing overlay above the composer instead.
 */
import { Editor, matchesKey, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';

function isBorderLine(line, width) {
  const plain = stripTerminalSequences(line);
  if (visibleWidth(plain) !== width) return false;
  if (/^─+$/u.test(plain)) return true;
  // Scrollable border: "─── ↑ 3 more ─────────……"
  return /^─── [↑↓] \d+ more ─*$/u.test(plain);
}

/** Remove the focused-editor cursor cell while the terminal is unfocused. */
export function stripFocusCursor(lines) {
  return lines.map((line) => line.replace(/\x1b\[7m([\s\S]*?)\x1b\[0m/gu, '$1'));
}

export function splitAutocomplete(lines, width) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!isBorderLine(lines[index], width)) continue;
    if (index === lines.length - 1) return { editor: lines, autocomplete: [] };
    return {
      editor: lines.slice(0, index + 1),
      autocomplete: lines.slice(index + 1),
    };
  }
  return { editor: lines, autocomplete: [] };
}

export class AttachEditor extends Editor {
  /** Called synchronously after the editor has handled one input event. */
  onAfterInput = undefined;
  /** Called when the suggestion list appears, changes, or is dismissed. */
  onAutocompleteChange = undefined;
  terminalFocused = true;

  handleInput(data) {
    const beforeText = this.getText();
    super.handleInput(data);
    this.onAfterInput?.(data);
    if (this.getText() === beforeText) return;
    const tab = matchesKey(data, 'tab');
    const space = data === ' ';
    if (!tab && !space) return;
    // Tab accepts a parent command such as `/skill` and leaves a trailing
    // space; typing the space after `/skill` has the same problem. pi-tui
    // does not auto-trigger for space in a slash-command argument, so ask the
    // provider again after either key.
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? '';
    const beforeCursor = line.slice(0, cursor.col);
    if (!beforeCursor.trimStart().startsWith('/') || !/\s$/u.test(beforeCursor)) return;
    const trigger = this.tryTriggerAutocomplete;
    if (typeof trigger === 'function') trigger.call(this);
  }

  /** Keep the app's floating overlay in sync with asynchronous provider results. */
  applyAutocompleteSuggestions(suggestions, state) {
    super.applyAutocompleteSuggestions(suggestions, state);
    this.onAutocompleteChange?.();
  }

  cancelAutocomplete() {
    const wasShowing = this.isShowingAutocomplete();
    super.cancelAutocomplete();
    if (wasShowing) this.onAutocompleteChange?.();
  }

  setTerminalFocused(value) {
    if (this.terminalFocused === value) return;
    this.terminalFocused = value;
    this.invalidate?.();
  }

  render(width) {
    const lines = this.snapshot(width).editor;
    return this.terminalFocused ? lines : stripFocusCursor(lines);
  }

  /** Render the editor and its suggestion block in one pass. */
  snapshot(width) {
    return splitAutocomplete(super.render(width), width);
  }

  /** Snapshot of the current suggestion block, rendered at `width`. */
  getAutocompleteLines(width) {
    return this.snapshot(width).autocomplete;
  }
}
