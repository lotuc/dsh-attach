// dsh-attach Web/Desktop client half.
//
// The TUI writes a one-shot focus request and raises the window with
// `dsh://open`. This bundle polls the loopback bridge and selects the exact
// session through the harness's `uiWorkspace.openSession` seam.
window.__ModuleLoader__.load({
  id: 'dsh-attach',
  factory() {
    const PORT = 39765;
    const POLL_MS = 500;
    const RETRY_MS = 200;
    const WAIT_MS = 10_000;

    function catalogued(ctx, id) {
      try {
        const snapshot = ctx.sessions.list.getSnapshot();
        return snapshot !== null
          && snapshot.byId !== undefined
          && Object.prototype.hasOwnProperty.call(snapshot.byId, id);
      } catch {
        return false;
      }
    }

    function selectSession(ctx, id) {
      let stopped = false;
      let timer = null;
      let waited = 0;
      const attempt = () => {
        timer = null;
        if (stopped) return;
        if (catalogued(ctx, id)) {
          try {
            ctx.uiWorkspace.openSession(id);
            window.focus();
            return;
          } catch {
            // Navigation may not be ready yet; keep retrying.
          }
        }
        if (waited >= WAIT_MS) return;
        waited += RETRY_MS;
        timer = window.setTimeout(attempt, RETRY_MS);
      };
      attempt();
      return () => {
        stopped = true;
        if (timer !== null) window.clearTimeout(timer);
      };
    }

    function startApprovalCompanion(ctx) {
      if (typeof EventSource !== 'function' || typeof ctx.uiSession?.sessionStatus?.getSnapshot !== 'function') {
        return () => {};
      }
      const settled = new Map();
      const handled = new Set();
      const keyOf = (event) => `${event.sessionId}\u0000${event.callId ?? ''}\u0000${event.toolName ?? ''}`;
      const findPending = (event) => {
        const statuses = ctx.uiSession.sessionStatus.getSnapshot();
        const pending = statuses.get(event.sessionId)?.pendingInteraction;
        if (pending?.kind !== 'approval' || pending.answerable === false) return null;
        if (event.callId && pending.callId && event.callId !== pending.callId) return null;
        if (!event.callId && event.toolName && pending.toolName && event.toolName !== pending.toolName) return null;
        return pending;
      };
      const reconcile = () => {
        for (const [key, event] of settled) {
          if (handled.has(key)) continue;
          const pending = findPending(event);
          if (pending === null) continue;
          handled.add(key);
          if (typeof pending.answer !== 'function') continue;
          if (event.outcome === 'allowed-once' || event.outcome === 'rejected') {
            // The Host has already accepted the terminal's outcome. This resolves
            // the local Web waterfall so the shared panel closes; the Host ignores
            // the duplicate decision because its pending entry is already settled.
            void Promise.resolve().then(() => pending.answer(event.outcome)).catch(() => {});
          } else if (typeof pending.abort === 'function') {
            pending.abort('answered elsewhere');
          }
        }
      };
      const source = new EventSource('/dsh-attach/interactions');
      source.addEventListener('interaction', (message) => {
        let event;
        try {
          event = JSON.parse(message.data);
        } catch {
          return;
        }
        if (event?.kind !== 'approval' || event.winner === 'web') return;
        const key = keyOf(event);
        settled.set(key, event);
        if (settled.size > 64) settled.delete(settled.keys().next().value);
        reconcile();
      });
      const status = ctx.uiSession.sessionStatus;
      const unsubscribe = typeof status.subscribe === 'function'
        ? status.subscribe(reconcile)
        : () => {};
      return () => {
        source.close();
        unsubscribe();
      };
    }

    return {
      inject: ['sessions', 'uiWorkspace', 'uiSession'],
      apply(ctx) {
        let stopped = false;
        let pollTimer = null;
        let cancelSelection = null;
        let polling = false;
        const poll = async () => {
          pollTimer = null;
          if (stopped || polling) return;
          polling = true;
          try {
            const response = await fetch(`http://127.0.0.1:${PORT}/focus`, { cache: 'no-store' });
            if (response.ok) {
              const value = await response.json();
              if (typeof value?.sessionId === 'string' && value.sessionId !== '') {
                cancelSelection?.();
                cancelSelection = selectSession(ctx, value.sessionId);
              }
            }
          } catch {
            // The Host may not be listening yet, or the bridge is disabled.
          } finally {
            polling = false;
            if (!stopped) pollTimer = window.setTimeout(poll, POLL_MS);
          }
        };
        ctx.effect(() => {
          poll();
          return () => {
            stopped = true;
            if (pollTimer !== null) window.clearTimeout(pollTimer);
            cancelSelection?.();
          };
        }, 'dsh-attach: desktop focus bridge');
        ctx.effect(() => startApprovalCompanion(ctx), 'dsh-attach: approval companion');
      },
    };
  },
});
