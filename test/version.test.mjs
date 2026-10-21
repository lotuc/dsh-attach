import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function match(text, pattern, label) {
  const found = text.match(pattern);
  assert.ok(found, `missing ${label} version`);
  return found[1];
}

test('all release version strings agree with package.json', async () => {
  const pkg = JSON.parse(await read('../package.json'));
  const version = pkg.version;
  const checks = [
    ['Host plugin', await read('../lib/host/server.js'), /const PLUGIN_VERSION = '([^']+)'/, 'PLUGIN_VERSION'],
    ['CLI', await read('../lib/client/cli.js'), /console\.log\('dsh-attach ([^']+)'\)/, 'CLI version'],
    ['client hello', await read('../lib/client/connection.js'), /version: '([^']+)', protocol: PROTOCOL_VERSION/, 'hello version'],
    ['Herdr manifest', await read('../herdr-plugin.toml'), /^version = "([^"]+)"/m, 'manifest version'],
  ];

  for (const [label, text, pattern, description] of checks) {
    assert.equal(match(text, pattern, description), version, `${label} is out of sync with package.json`);
  }
});
