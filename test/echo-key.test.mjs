import assert from 'node:assert/strict';
import test from 'node:test';

import { contentEchoKey } from '../lib/client/echo-key.js';

test('user message echo keys include text and image count without markers', () => {
  const image = { type: 'image', mediaType: 'image/png', data: 'x' };
  assert.equal(contentEchoKey([{ type: 'text', text: 'look' }, image]), 'look\u00001');
  assert.equal(contentEchoKey([image, image]), '\u00002');
  assert.equal(contentEchoKey([{ type: 'text', text: 'plain' }]), 'plain\u00000');
  assert.equal(contentEchoKey('plain [image]'), 'plain ');
});
