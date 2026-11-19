/**
 * Normalize the failure payloads carried by assistant attempts and turn ends.
 *
 * A failed attempt ends with a `finish` chunk whose reason has `kind: 'error'`
 * and a `failure` object. The terminal `turn/end` repeats it under
 * `reason.error`. Keeping extraction here means both paths render the same
 * message, code and HTTP status.
 */

function normalizeFailure(value) {
  if (value === null || typeof value !== 'object') return null;
  const message = typeof value.message === 'string' ? value.message.replace(/\s+/gu, ' ').trim() : '';
  const code = typeof value.code === 'string' ? value.code.trim() : '';
  const statusNumber = Number(value.status);
  const status = Number.isFinite(statusNumber) ? statusNumber : null;
  if (message === '' && code === '') return null;
  return { message, code, status };
}

function fromReason(reason) {
  if (reason === null || typeof reason !== 'object') return null;
  return normalizeFailure(reason.error ?? reason.failure);
}

/** Failure from one `assistant/attempt` event, or null when it has none. */
export function attemptFailure(data) {
  const stream = Array.isArray(data?.stream) ? data.stream : [];
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const chunk = stream[index]?.chunk;
    if (chunk?.type !== 'finish') continue;
    const failure = normalizeFailure(chunk.reason?.failure ?? chunk.reason?.error);
    if (failure !== null) return failure;
  }
  return normalizeFailure(data?.failure) ?? normalizeFailure(data?.error);
}

/** Failure from one `turn/end` event, or null when it is not an error end. */
export function turnFailure(data) {
  return fromReason(data?.reason)
    ?? normalizeFailure(data?.error)
    ?? normalizeFailure(data?.failure);
}

/** Human-readable failure text with the provider code and HTTP status. */
export function failureText(failure) {
  if (failure === null || failure === undefined) return '';
  const message = failure.message !== '' ? failure.message : 'model request failed';
  const meta = [];
  if (failure.code !== '' && !message.includes(failure.code)) meta.push(failure.code);
  if (failure.status !== null) meta.push(`HTTP ${failure.status}`);
  return meta.length === 0 ? message : `${message} [${meta.join(' · ')}]`;
}
