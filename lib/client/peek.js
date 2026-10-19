import { AttachClient } from './connection.js';
import { oneLine, partsOfMessage, sanitizeText, textOfContent } from './transcript.js';

/**
 * Keep a tiny bounded tail of one running child Session for the parent's
 * bottom peek. Each peek owns one lightweight socket; it never renders the
 * full transcript and never opens an editor or approval UI.
 */
export class PeekSession {
  #parent;
  #client = new AttachClient();
  #onUpdate;
  #stopped = false;
  #signature = '';
  #live = '';
  #liveTimer = null;
  #toolNames = new Map();

  constructor(parentClient, info, { onUpdate } = {}) {
    this.#parent = parentClient;
    this.#onUpdate = onUpdate;
    this.id = String(info.id);
    this.parentSessionId = info.parentSessionId === undefined || info.parentSessionId === null
      ? null
      : String(info.parentSessionId);
    this.title = typeof info.title === 'string' && info.title.trim() !== '' ? info.title : this.id.slice(0, 8);
    this.status = 'connecting';
    this.lines = [];
    this.error = null;
  }

  get sessionId() {
    return this.id;
  }

  get client() {
    return this.#client;
  }

  #emit() {
    const signature = `${this.status}\n${this.title}\n${this.lines.join('\n')}`;
    if (signature === this.#signature) return;
    this.#signature = signature;
    try {
      this.#onUpdate?.();
    } catch {
      // Parent UI may be gone.
    }
  }

  #setText(text) {
    const clean = sanitizeText(text).replace(/\r/gu, '');
    const lines = clean
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .slice(-2)
      .map((line) => oneLine(line, 180));
    if (lines.length > 0) this.lines = lines;
  }

  #handleEvent(event) {
    if (event === null || typeof event !== 'object' || this.#stopped) return;
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
    switch (event.type) {
      case 'user/message': {
        const text = textOfContent(data.content);
        if (text.trim() !== '') this.lines = [`› ${oneLine(text, 180)}`];
        break;
      }
      case 'assistant/message': {
        const { text } = partsOfMessage(data.message);
        this.#live = text;
        if (this.#liveTimer !== null) {
          clearTimeout(this.#liveTimer);
          this.#liveTimer = null;
        }
        this.#setText(text);
        break;
      }
      case 'tool/call': {
        if (typeof data.name === 'string') {
          if (typeof data.callId === 'string') this.#toolNames.set(data.callId, data.name);
          this.lines = [`⚙ ${data.name} ${oneLine(data.arguments ?? '', 100)}`];
        }
        break;
      }
      case 'tool/result': {
        const callId = typeof data.message?.toolCallId === 'string' ? data.message.toolCallId : '';
        const name = this.#toolNames.get(callId) ?? 'tool';
        const summary = textOfContent(data.message?.content);
        const failed = data.error !== undefined || data.message?.isError === true;
        this.lines = [`${failed ? '✗' : '✓'} ${name} ${oneLine(summary, 140)}`];
        break;
      }
      case 'turn/start':
        this.status = 'running';
        this.#live = '';
        break;
      case 'turn/end':
        this.status = 'idle';
        if (this.#liveTimer !== null) {
          clearTimeout(this.#liveTimer);
          this.#liveTimer = null;
        }
        if (this.#live !== '') this.#setText(this.#live);
        this.#live = '';
        break;
      case 'session/title':
        if (typeof data.title === 'string' && data.title.trim() !== '') this.title = data.title;
        break;
      case 'approval/asked':
        this.status = 'blocked';
        if (typeof data.toolName === 'string') this.lines = [`! ${data.toolName} approval`];
        break;
      case 'approval/decided':
        this.status = 'running';
        break;
      case 'llm/retry':
        this.lines = [`… retrying ${oneLine(data.reason ?? data.error?.message ?? '', 100)}`];
        break;
      case 'compaction/start':
        this.lines = ['… compacting context'];
        break;
      default:
        return;
    }
    this.#emit();
  }

  #renderAttempt(attempt) {
    if (attempt === null || typeof attempt !== 'object') return;
    let text = '';
    for (const record of Array.isArray(attempt.stream) ? attempt.stream : []) {
      if (record?.type === 'chunk' && record.chunk?.type === 'text-delta' && typeof record.chunk.text === 'string') {
        text += record.chunk.text;
      } else if (record?.type === 'text-chunks' && Array.isArray(record.texts)) {
        text += record.texts.join('');
      }
    }
    if (text !== '') {
      this.#live = text;
      this.#setText(text);
      this.status = 'running';
    }
  }

  #scheduleTextUpdate() {
    if (this.#liveTimer !== null) return;
    this.#liveTimer = setTimeout(() => {
      this.#liveTimer = null;
      if (this.#stopped) return;
      this.#setText(this.#live);
      this.#emit();
    }, 100);
    this.#liveTimer.unref?.();
  }

  #onFrame(message) {
    if (this.#stopped || String(message.sessionId) !== this.id) return;
    const frame = message.frame;
    if (frame === null || typeof frame !== 'object') return;
    if (frame.type === 'snapshot') {
      const values = frame.projections?.values ?? {};
      if (typeof values.title === 'string' && values.title.trim() !== '') this.title = values.title;
      this.status = 'idle';
      for (const record of Array.isArray(frame.records) ? frame.records : []) {
        if (record?.type === 'event') this.#handleEvent(record.event);
      }
      if (frame.assistantStream?.activeAttempt !== undefined) this.#renderAttempt(frame.assistantStream.activeAttempt);
      this.#emit();
      return;
    }
    if (frame.type === 'event') {
      this.#handleEvent(frame.event);
      return;
    }
    if (frame.type === 'assistant-stream') {
      const inner = frame.frame;
      if (inner?.type === 'start') {
        this.status = 'running';
        this.#live = '';
        this.#emit();
      } else if (inner?.type === 'chunk') {
        const chunk = inner.chunk;
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          this.status = 'running';
          this.#live = `${this.#live}${chunk.text}`.slice(-20_000);
          this.#scheduleTextUpdate();
        }
      }
    }
  }

  async start() {
    try {
      const descriptor = this.#parent.descriptor;
      if (descriptor === null || descriptor === undefined) throw new Error('parent descriptor is unavailable');
      await this.#client.connect({
        socketPath: descriptor.socketPath,
        token: descriptor.token,
        profile: descriptor.profile,
        timeoutMs: 4_000,
      });
      if (this.#stopped) {
        this.#client.close();
        return;
      }
      this.#client.on('frame', (message) => this.#onFrame(message));
      this.#client.on('session-error', (message) => {
        if (String(message.sessionId) !== this.id) return;
        this.status = 'error';
        this.error = message.error?.message ?? 'session stream failed';
        this.#emit();
      });
      this.#client.on('close', () => {
        if (this.#stopped) return;
        this.status = 'closed';
        this.#emit();
      });
      await this.#client.request('session.open', {
        sessionId: this.id,
        ...(this.parentSessionId === null ? {} : { parentSessionId: this.parentSessionId, mode: 'unknown' }),
      });
      if (this.#stopped) {
        this.#client.close();
        return;
      }
      if (this.status === 'connecting') this.status = 'idle';
      this.#emit();
    } catch (error) {
      this.status = 'error';
      this.error = error instanceof Error ? error.message : String(error);
      this.#emit();
    }
  }

  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#liveTimer !== null) {
      clearTimeout(this.#liveTimer);
      this.#liveTimer = null;
    }
    this.#client.close();
  }
}
