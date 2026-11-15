/**
 * Loopback focus bridge between the TUI and the DSH Web/Desktop client plugin.
 *
 * The TUI writes one request file; the browser half polls `/focus`, consumes it
 * and calls `ctx.uiWorkspace.openSession(sessionId)`. `dsh://open` is only used
 * to raise the window; no session id travels through the protocol.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';

import { resolveDshHome } from '../shared/paths.js';

export const FOCUS_PORT = 39765;
export const FOCUS_TTL_MS = 30_000;

export function focusRequestPath(home = resolveDshHome()) {
  return join(home, 'dsh-attach', 'focus-request.json');
}

/** Write a one-shot focus request for the browser half. */
export function writeFocusRequest(sessionId, { home = resolveDshHome(), now = Date.now() } = {}) {
  const id = String(sessionId ?? '').trim();
  if (id === '') throw new Error('sessionId is required');
  const path = focusRequestPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ sessionId: id, at: now }), { mode: 0o600 });
  return path;
}

/** Read and consume one unexpired request, or null. */
export function takeFocusRequest({ home = resolveDshHome(), now = Date.now() } = {}) {
  const path = focusRequestPath(home);
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  try {
    unlinkSync(path);
  } catch {
    // Another consumer already took it.
  }
  if (value === null || typeof value !== 'object') return null;
  if (typeof value.sessionId !== 'string' || value.sessionId === '') return null;
  if (!Number.isFinite(value.at) || now - value.at > FOCUS_TTL_MS || value.at > now + 5_000) return null;
  return value.sessionId;
}

/**
 * Start the loopback HTTP endpoint. Failures are reported but never reject the
 * Host fiber; the TUI still focuses the window when the bridge is unavailable.
 */
export function startFocusBridge({ port = FOCUS_PORT, home = resolveDshHome(), log = () => {} } = {}) {
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
      response.end();
      return;
    }
    if (request.method !== 'GET' || request.url?.split('?')[0] !== '/focus') {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found');
      return;
    }
    const sessionId = takeFocusRequest({ home });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(sessionId === null ? {} : { sessionId }));
  });
  server.on('error', (error) => log(`focus bridge unavailable: ${error.message}`));
  server.listen(port, '127.0.0.1', () => log(`focus bridge listening on 127.0.0.1:${port}`));
  server.unref?.();
  return {
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
