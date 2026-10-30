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
  /** Delegate an unanswered approval to the Web GUI after this long (0 waits forever). */
  approvalGraceSeconds: z.number().default(120),
  /** Delegate an unanswered question batch after this long (0 waits forever). */
  questionGraceSeconds: z.number().default(300),
});

/**
 * Mount the attach server for the lifetime of this plugin fiber.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  if (config.enabled !== true) return;
  const server = new AttachServer(ctx, config);
  ctx.effect(() => {
    server.start().catch((error) => {
      ctx.logger?.warn?.('[dsh-tui-attach] cannot start attach bridge: %s', error instanceof Error ? error.message : String(error));
    });
    return () => {
      void server.stop();
    };
  }, 'dsh-tui-attach: unix attach bridge');
}
