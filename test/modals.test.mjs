import assert from 'node:assert/strict';
import test from 'node:test';

import { ModalHost } from '../lib/client/modals.js';

function makeTui() {
  const handles = [];
  return {
    handles,
    focused: null,
    renders: 0,
    showOverlay(component, options) {
      const handle = {
        component,
        options,
        hidden: false,
        hide() {
          this.hidden = true;
        },
      };
      handles.push(handle);
      return handle;
    },
    setFocus(target) {
      this.focused = target;
    },
    requestRender() {
      this.renders += 1;
    },
  };
}

test('ModalHost opens, gets and reports named slots', () => {
  const tui = makeTui();
  const modals = new ModalHost(tui, () => 'editor');
  const component = { name: 'info' };

  const slot = modals.open('info', component, { width: 80 }, { requestId: 'r1' });
  assert.equal(slot.component, component);
  assert.equal(slot.handle.component, component);
  assert.equal(slot.data.requestId, 'r1');
  assert.equal(modals.get('info'), slot);
  assert.equal(modals.has('info'), true);
  assert.equal(modals.has('missing'), false);
  assert.equal(modals.anyOpen(), true);
  assert.deepEqual(modals.names(), ['info']);
});

test('opening the same slot replaces and hides the previous overlay', () => {
  const tui = makeTui();
  const modals = new ModalHost(tui, () => 'editor');
  const first = modals.open('picker', { id: 1 });
  const second = modals.open('picker', { id: 2 });

  assert.equal(first.handle.hidden, true);
  assert.equal(second.handle.hidden, false);
  assert.equal(modals.get('picker').component.id, 2);
  assert.equal(tui.handles.length, 2);
});

test('close and closeAll hide overlays and restore focus only when asked', () => {
  const tui = makeTui();
  const modals = new ModalHost(tui, () => 'editor');
  const info = modals.open('info', {});
  modals.open('jobs', {});

  assert.equal(modals.close('info'), true);
  assert.equal(info.handle.hidden, true);
  assert.equal(modals.has('info'), false);
  assert.equal(tui.focused, null, 'close does not steal focus by default');
  assert.equal(modals.close('info'), false);

  modals.closeAll({ focus: true });
  assert.equal(modals.anyOpen(), false);
  assert.equal(tui.focused, 'editor');
  assert.equal(modals.names().length, 0);
});
