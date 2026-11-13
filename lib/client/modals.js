/**
 * Named overlay slots for one TUI.
 *
 * pi-tui returns opaque overlay handles. Keeping them in one registry prevents
 * every panel from adding another field, another "is anything open?" predicate
 * and another entry in the quit path. Focus policy stays with the caller: the
 * registry only opens, exposes and hides overlays.
 */
export class ModalHost {
  #tui;
  #focusTarget;
  #slots = new Map();

  /**
   * @param {import('@earendil-works/pi-tui').TUI} tui
   * @param {() => import('@earendil-works/pi-tui').Component} focusTarget
   */
  constructor(tui, focusTarget) {
    this.#tui = tui;
    this.#focusTarget = focusTarget;
  }

  /**
   * Show a component in a named slot, replacing an existing overlay there.
   * @param {string} name
   * @param {object} component
   * @param {object} [options]
   * @param {object} [data] - caller state stored beside the handle
   * @returns {{name: string, component: object, handle: object, options: object, data: object}}
   */
  open(name, component, options = {}, data = {}) {
    this.close(name, { focus: false, render: false });
    const handle = this.#tui.showOverlay(component, options);
    const slot = { name, component, handle, options, data };
    this.#slots.set(name, slot);
    this.#tui.requestRender?.();
    return slot;
  }

  /**
   * Replace one overlay's frame options without recreating its component.
   * Used by fullscreen toggles so scroll position and in-flight state survive.
   * @param {string} name
   * @param {object} options
   * @returns {boolean}
   */
  resize(name, options = {}) {
    const slot = this.#slots.get(name);
    if (slot === undefined) return false;
    slot.handle.hide();
    slot.handle = this.#tui.showOverlay(slot.component, options);
    slot.options = options;
    this.#tui.requestRender?.();
    return true;
  }

  /**
   * @param {string} name
   * @returns {object|null}
   */
  get(name) {
    return this.#slots.get(name) ?? null;
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.#slots.has(name);
  }

  /** True when any registered overlay is open. */
  anyOpen() {
    return this.#slots.size > 0;
  }

  /** @returns {string[]} */
  names() {
    return [...this.#slots.keys()];
  }

  /**
   * Hide one overlay and drop its slot.
   * @param {string} name
   * @param {{focus?: boolean, render?: boolean}} [options]
   * @returns {boolean} whether a slot existed
   */
  close(name, { focus = false, render = true } = {}) {
    const slot = this.#slots.get(name);
    if (slot === undefined) return false;
    this.#slots.delete(name);
    slot.handle.hide();
    if (focus) this.focus();
    if (render) this.#tui.requestRender?.();
    return true;
  }

  /**
   * Hide every overlay. Callers still own per-panel timers and list state.
   * @param {{focus?: boolean, render?: boolean}} [options]
   */
  closeAll({ focus = false, render = true } = {}) {
    if (this.#slots.size === 0) return;
    for (const name of [...this.#slots.keys()]) this.close(name, { focus: false, render: false });
    if (focus) this.focus();
    if (render) this.#tui.requestRender?.();
  }

  /** Restore focus to the editor (or whichever target was supplied). */
  focus() {
    this.#tui.setFocus(this.#focusTarget());
  }
}
