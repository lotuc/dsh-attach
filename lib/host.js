/**
 * `dsh-tui-attach` Host plugin.
 *
 * Mounting this plugin starts a local Unix-socket bridge inside the running
 * DSH process. The companion terminal client (`dsh-attach`) uses that bridge to
 * list, open and drive the *same* sessions, including the live agent, approval
 * prompts and user questions.
 *
 * The bridge is opt-in when the bundle is installed. Set `enabled: false` to
 * disable it without uninstalling.
 */
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';

import z from '@deepseek-ai/schemastery';
import { AttachServer } from './host/server.js';

/** Stable Cordis plugin name. */
export const name = 'dsh-tui-attach';

/** The bridge needs the Session domain; it is present in Web and Desktop. */
export const inject = ['sessionController'];

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** Override the socket path; empty means `$DSH_HOME/tui-attach/attach-<pid>.sock`. */
  socketPath: z.string().default(''),
  /**
   * Who answers approval prompts while the terminal is attached:
   * `auto` prefers the terminal after recent activity (or when no Web client is
   * connected); `tui` always asks the terminal; `web` leaves them to the Web GUI;
   * `off` disables terminal approvals.
   */
  approvals: z.union(['auto', 'tui', 'web', 'off']).default('tui'),
  /** Same policy for `ask_user_question` batches. */
  questions: z.union(['auto', 'tui', 'web', 'off']).default('tui'),
  /** How recently the terminal must have acted for `auto` to prefer it. */
  activeWindowMinutes: z.number().default(10),
  /** Maximum messages in one follow snapshot or older-history page (clamped by the bridge). */
  historyMessages: z.number().default(300),
  /** Delegate an unanswered approval to the Web GUI after this long (0 waits forever). */
  approvalGraceSeconds: z.number().default(120),
  /** Delegate an unanswered question batch after this long (0 waits forever). */
  questionGraceSeconds: z.number().default(300),
  /** Development only: hot-reload host/server.js when it changes. */
  hotReload: z.boolean().default(false),
});

/**
 * Mount the attach server for the lifetime of this plugin fiber.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  if (config.enabled !== true) return;
  let server = new AttachServer(ctx, config);
  let watcher = null;
  let timer = null;
  let reloading = false;
  let disposed = false;
  const log = (message) => {
    ctx.logger?.warn?.(`[dsh-tui-attach] ${message}`);
  };
  const start = () => {
    server.start().catch((error) => {
      log(`cannot start attach bridge: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const reload = async () => {
    if (reloading || disposed) return;
    reloading = true;
    const previous = server;
    try {
      await previous.stop();
      const module = await import(`./host/server.js?hot=${Date.now()}`);
      if (disposed) return;
      server = new module.AttachServer(ctx, config);
      await server.start();
      log('hot-reloaded host/server.js');
    } catch (error) {
      log(`hot reload failed: ${error instanceof Error ? error.message : String(error)}; restoring previous bridge`);
      server = previous;
      if (!disposed) {
        try {
          await previous.start();
        } catch {
          // The old bridge may not be restartable after a failed stop.
        }
      }
    } finally {
      reloading = false;
    }
  };
  const scheduleReload = () => {
    if (disposed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void reload();
    }, 200);
    timer.unref?.();
  };
  ctx.effect(() => {
    start();
    if (config.hotReload === true || process.env.DSH_ATTACH_HOT === '1') {
      try {
        const dir = fileURLToPath(new URL('./host/', import.meta.url));
        watcher = watch(dir, (_event, filename) => {
          if (filename === null || filename === 'server.js') scheduleReload();
        });
        watcher.on('error', () => {});
        log(`watching ${dir}server.js for hot reload`);
      } catch (error) {
        log(`cannot watch server.js: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      watcher?.close();
      watcher = null;
      void server.stop();
    };
  }, 'dsh-tui-attach: unix attach bridge');
}
