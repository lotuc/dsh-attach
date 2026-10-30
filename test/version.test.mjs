import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { VERSION } from '../lib/shared/version.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function match(text, pattern, label) {
  const found = text.match(pattern);
  assert.ok(found, `missing ${label} version`);
  return found[1];
}

test('all release version strings agree with package.json', async () => {
  const pkg = JSON.parse(await read('../package.json'));
  const version = pkg.version;

  assert.equal(VERSION, version, 'shared VERSION is out of sync with package.json');

  const manifest = match(await read('../herdr-plugin.toml'), /^version = "([^"]+)"/m, 'manifest version');
  assert.equal(manifest, version, 'Herdr manifest is out of sync with package.json');

  // The implementation must consume the shared constant rather than copy it.
  assert.match(await read('../lib/host/server.js'), /pluginVersion: VERSION/);
  assert.match(await read('../lib/client/cli.js'), /console\.log\(`dsh-attach \$\{VERSION\}`\)/);
  assert.match(await read('../lib/client/connection.js'), /version: VERSION, protocol: PROTOCOL_VERSION/);
});
