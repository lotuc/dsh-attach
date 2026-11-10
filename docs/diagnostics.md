# Diagnostics

## Lifecycle log

Default: `$DSH_HOME/dsh-attach/client.log` (`0700` dir, `0600` file), rotated at
2 MB to `client.log.1`.

```sh
tail -f "${DSH_HOME:-$HOME/.dsh}/dsh-attach/client.log"
dsh-attach --log /tmp/dsh-attach.log
dsh-attach --log off
```

Logged: pid, version, argv (`--token` redacted), terminal env, session opens,
focus changes, signals, quit reason, errors, exit code. Prompt text is not
logged. Focus entries are throttled with a `suppressed` count.

The `start` entry includes `TERM`, `TERM_PROGRAM`, `TMUX`, `HERDR_ENV`,
`SSH_TTY`, TTY state, columns, and rows.

## Quit reasons

| Entry | Meaning |
|---|---|
| `ctrl+c` | Ctrl+C / Ctrl+C twice. |
| `command` | `/quit` or `/exit`. |
| `signal SIGHUP/SIGTERM/SIGINT/SIGQUIT` | External termination. |
| `stdin-end` / `stdin-close` | TTY closed. |
| `stdin-error` | stdin read failed. |
| `before-exit` | Event loop ended without normal quit. |
| `uncaughtException` | Fatal JS error; includes stack. |
| `unhandledRejection` | Logged; TUI continues. |
| `process-exit` | Final code. |

Codes: 129 SIGHUP, 130 SIGINT, 131 SIGQUIT, 143 SIGTERM, 137 SIGKILL (usually
no log entry).

No quit record usually means SIGKILL/crash, logging off, or failure before the
TUI started. Capture it with:

```sh
while :; do
  dsh-attach -s <session-id>
  code=$?
  printf '%s exit=%s\n' "$(date '+%F %T')" "$code" | tee -a ~/.dsh/dsh-attach/exit.log
  [ "$code" -eq 0 ] && break
  sleep 1
done
```

## Focus and keys

- `focus {"state":"out"}` / `"in"` are consumed, never treated as `Esc`.
- `DSH_ATTACH_NO_MOUSE=1` disables mouse/focus reporting.
- `DSH_ATTACH_KEYS=1` logs raw keys (may include prompt text); temporary use.
- `Esc` on the initial picker does not exit; use `Ctrl+C` twice or `/quit`.

## Performance

- **Render cache**: only rows whose fields or width changed reflow.
- **Bounded transcript**: 5,000 rows while following; 10,000 hard cap; trim
  deferred while scrolled up.
- **Subagent refresh**: `subagent.summary` debounced/polled; older Hosts use
  `session.list` less often.
- **Session discovery**: in-flight requests shared, 5s cache, optional workspace
  lookup capped at 300 ms.
- **Mouse**: button-motion tracking by default; enable full motion with
  `DSH_ATTACH_FULL_MOUSE=1`.
- **Long answers**: above 40k chars, live view renders tail only; Markdown is
  laid out once at finalize.

Measure:

```sh
DSH_ATTACH_PERF=1 dsh-attach -s <session-id>
```

Logs: `frame-stats` every 50 frames, per-key `input-latency`, `loop-lag` over
100 ms, `transcript-trim`, subagent refresh/control events, and
`session-picker` timing.

## Host capabilities

- `subagent.summary` (0.11.7+) avoids full session-list polling.
- Active subagent IDs (0.13+) drive the peek.
- `history.pagination` backs `Ctrl+R`/`/history`.
- Lifecycle capabilities are advertised only when supported:
  `session.fork`, `session.archive`, `session.pin`, `session.presets`.
- Missing capability is reported as unsupported, not a route failure.
- DSH has no Session deletion; archive is the supported end state.
- Subagent control requires `ctx.subagents.prompt`/`interruptByParent`.
- `goal.complete` is advertised only when `GoalService.complete` exists.
