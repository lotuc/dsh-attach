/**
 * Wire constants shared by the Host bridge and the terminal client.
 *
 * Transport: a Unix-domain socket carrying newline-delimited UTF-8 JSON.
 * The first line from the client is a `hello` carrying the token from the
 * endpoint descriptor; everything after that is request/response/notification
 * traffic. The socket and descriptor live under `$DSH_HOME/tui-attach/` with
 * owner-only permissions, so the protocol is reachable only by the same user.
 */

export const PROTOCOL_VERSION = 1;

export const ENDPOINT_DIR = 'tui-attach';
export const ENDPOINT_FILE = 'endpoint.json';

/** Hard cap for one inbound line. History snapshots travel outbound, not in. */
export const MAX_INBOUND_LINE_BYTES = 4 * 1024 * 1024;
/** Hard cap for one outbound line (a history snapshot can be a few MiB). */
export const MAX_OUTBOUND_LINE_BYTES = 64 * 1024 * 1024;
/** How long a new socket may stay unauthenticated. */
export const HELLO_TIMEOUT_MS = 10_000;

/**
 * Encode one JSON message as a single line.
 * @param {unknown} message
 * @returns {string}
 */
export function encodeLine(message) {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Split a growing UTF-8 buffer into complete newline-terminated lines.
 * Keeps the unterminated tail in the buffer.
 * @param {{ value: string }} buffer
 * @param {string} chunk
 * @returns {string[]} complete lines, without the trailing newline
 */
export function takeLines(buffer, chunk) {
  buffer.value += chunk;
  const lines = [];
  let index = buffer.value.indexOf('\n');
  while (index >= 0) {
    lines.push(buffer.value.slice(0, index));
    buffer.value = buffer.value.slice(index + 1);
    index = buffer.value.indexOf('\n');
  }
  return lines;
}
