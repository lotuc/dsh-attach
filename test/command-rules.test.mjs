import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPathWithin,
  isSafeReadOnlyCommand,
  matchesCommandPrefix,
  normalizeCommand,
  normalizeCommandPrefix,
  splitShellCommands,
} from '../lib/shared/command-rules.js';

test('splits compound commands while respecting quotes', () => {
  assert.deepEqual(splitShellCommands('cd /work && npm test; echo "a;b" | tail -5'), [
    ['cd', '/work'],
    ['npm', 'test'],
    ['echo', 'a;b'],
    ['tail', '-5'],
  ]);
  assert.deepEqual(splitShellCommands('timeout 900 env A=1 java -jar app.jar > /tmp/log 2>&1'), [
    ['timeout', '900', 'env', 'A=1', 'java', '-jar', 'app.jar', '>', '/tmp/log', '2>&1'],
  ]);
});

test('rejects shell constructs that cannot be classified safely', () => {
  assert.equal(splitShellCommands('echo $(cat secret)'), null);
  assert.equal(splitShellCommands('for f in a b; do echo $f; done'), null);
  assert.equal(splitShellCommands('cat <<EOF\nhello\nEOF'), null);
  assert.equal(splitShellCommands('echo "unclosed'), null);
});

test('treats grouping parentheses as transparent but still splits their commands', () => {
  assert.deepEqual(splitShellCommands('cd /tmp && (temporal server start-dev &)'), [
    ['cd', '/tmp'],
    ['temporal', 'server', 'start-dev'],
  ]);
});

test('strips env assignments, wrappers, and cd', () => {
  assert.deepEqual(normalizeCommand(['A=1', 'timeout', '900', 'clojure', '-T:build']), ['clojure', '-T:build']);
  assert.deepEqual(normalizeCommand(['env', 'A=1', 'nice', '-n', '5', 'java', '-jar', 'x']), ['java', '-jar', 'x']);
  assert.deepEqual(normalizeCommand(['cd', '/work']), []);
  assert.deepEqual(normalizeCommand(['sudo', 'rm', '-rf', '/']), ['sudo', 'rm', '-rf', '/']);
});

test('matches ordered token prefixes and alternatives', () => {
  assert.equal(matchesCommandPrefix(['npm', 'test'], ['npm', 'test', '--run']), true);
  assert.equal(matchesCommandPrefix(['npm', 'run'], ['npm', 'test']), false);
  assert.equal(matchesCommandPrefix([['clojure', 'mvn']], ['mvn', 'test']), true);
  assert.equal(normalizeCommandPrefix(['npm', ['test', 'run']]).length, 2);
  assert.equal(normalizeCommandPrefix([]), null);
});

test('identifies safe read-only and path prefixes', () => {
  assert.equal(isSafeReadOnlyCommand(['tail', '-5', 'log']), true);
  assert.equal(isSafeReadOnlyCommand(['bash', 'script.sh']), false);
  assert.equal(isPathWithin('/work/a/b', '/work'), true);
  assert.equal(isPathWithin('/worker', '/work'), false);
});
