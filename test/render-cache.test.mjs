import assert from 'node:assert/strict';
import test from 'node:test';

import { CachedRow } from '../lib/client/transcript.js';

test('reuses a row render until a mutable field or width changes', () => {
  let renders = 0;
  const row = {
    text: 'a',
    render(width) {
      renders += 1;
      return [`${this.text}:${width}`];
    },
  };
  const cached = new CachedRow(row);
  assert.deepEqual(cached.render(10), ['a:10']);
  assert.deepEqual(cached.render(10), ['a:10']);
  assert.equal(renders, 1);

  row.text = 'b';
  assert.deepEqual(cached.render(10), ['b:10']);
  assert.equal(renders, 2);

  assert.deepEqual(cached.render(20), ['b:20']);
  assert.equal(renders, 3);

  row.expanded = true;
  row.isExpanded = () => row.expanded;
  assert.deepEqual(cached.render(20), ['b:20']);
  row.expanded = false;
  assert.deepEqual(cached.render(20), ['b:20']);
  assert.equal(renders, 5);
});
