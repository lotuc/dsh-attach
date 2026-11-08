# Diagnostics and performance

## Lifecycle log

The client writes an append-only lifecycle log to
`$DSH_HOME/tui-attach/client.log` by default. The directory is `0700` and the
file is `0600`. When the file exceeds 2 MB it is rotated to `client.log.1`.

```sh
tail -f "${DSH_HOME:-$HOME/.dsh}/tui-attach/client.log"
```

Controls:

```sh
dsh-attach --log /tmp/dsh-attach.log
dsh-attach --log off
DSH_ATTACH_LOG=off dsh-attach
```

The log records the process ID, client version, argument vector (`--token` is
redacted), terminal environment, session opens, focus changes, signals, quit
reason, uncaught exceptions, and the final exit code. It does not record prompt
text.

Focus events are throttled to one entry every 2 seconds. The next entry carries
a `suppressed` count for events that were coalesced.

The `start` entry includes `TERM`, `TERM_PROGRAM`, `TMUX`, `HERDR_ENV`,
`SSH_TTY`, TTY state, and terminal dimensions. This is usually enough to tell
whether a problem is terminal-specific.

## Quit reasons

| Log entry | Meaning |
|---|---|
| `quit reason=ctrl+c` | A Ctrl+C byte was received, either from the user or from a terminal or script. |
| `quit reason=command` | `/quit` or `/exit` was used. |
| `quit reason=picker-empty` | Legacy behavior: the initial picker was closed with Escape. Current builds keep the client open and show a hint instead. |
| `signal signal=SIGHUP` | The terminal, tmux, Herdr, or SSH connection hung up. |
| `signal signal=SIGTERM` / `SIGINT` / `SIGQUIT` | The process was terminated externally. |
| `stdin-end`, `stdin-close` | The terminal pseudo-TTY closed. Both paths record a quit and an exit. |
| `stdin-error` | Reading stdin failed. |
| `before-exit` | The event loop was about to exit naturally without going through the normal quit path. Useful for finding silent exits. |
| `uncaughtException`, `unhandledRejection` | A JavaScript error; the log includes a stack. |
| `process-exit code=...` | Final process exit code. |

An `unhandledRejection` is logged and shown in the transcript as an internal
error, but the TUI keeps the session open. An `uncaughtException` still exits
because the process state can no longer be trusted.

Exit codes from signals:

| Code | Signal |
|---:|---|
| 129 | SIGHUP |
| 130 | SIGINT |
| 131 | SIGQUIT |
| 143 | SIGTERM |
| 137 | SIGKILL (normally no log entry) |

### No quit record at all

If the log has no exit record, common causes are:

- SIGKILL or a terminal/system crash;
- `DSH_ATTACH_LOG=off` or an unwritable log path;
- the process exited before `AttachApp` was constructed, for example because the
  connection failed or there was no TTY.

A shell wrapper can capture the status around the client:

```sh
while :; do
  dsh-attach -s <session-id>
  code=$?
  printf '%s exit=%s\n' "$(date '+%F %T')" "$code" | tee -a ~/.dsh/tui-attach/exit.log
  [ "$code" -eq 0 ] && break
  sleep 1
done
```

## Focus debugging

The client understands terminal focus reports and hides the empty-composer
cursor while the terminal is unfocused.

- `focus {"state":"out"}` and `focus {"state":"in"}` entries mean the terminal
  sent focus events. They are consumed at the viewport layer and never become
  Escape keys or panel-closing events.
- Focus logging is throttled every 2 seconds; `suppressed` reports merged
  events.
- `DSH_ATTACH_NO_MOUSE=1` disables both mouse and focus reporting. If the
  problem disappears, the issue is in the focus or mouse reporting path.
- `DSH_ATTACH_KEYS=1` records raw key input. This can include prompt content;
  enable it only for temporary debugging.
- Reproduce in tmux, directly in iTerm2, and in a Herdr pane to distinguish
  terminal, multiplexer, and Herdr behavior.
- Closing the initial session picker with Escape no longer exits the client.
  Press `Ctrl+C` once while idle, or twice while a turn/panel is active (or run `/quit`), for an explicit exit.

## Performance

The client is tuned for long-running sessions:

- **Row-level render cache.** Historical messages, tool cards, and reasoning
  reflow only when a displayed field (text, expand state, status, arguments, and
  so on) or the terminal width changes. Ordinary key presses do not re-wrap the
  whole history. A streaming answer re-renders only the row that is growing.
- **Bounded transcript.** While following the end, the transcript keeps at most
  5,000 rendered rows and drops the oldest rows. Trimming is deferred while you
  are scrolled up, with a 10,000-row hard bound so a long-lived session cannot
  grow without limit.
- **Throttled subagent refresh.** Newer Hosts use the small
  `subagent.summary` response with roughly a 1-second debounce and an 8-second
  poll. Older Hosts fall back to `session.list` at roughly 24-second intervals
  and do not refresh on every tool result during a parent turn. The summary
  refresh itself does not trigger a redraw or Herdr report when the total and
  running counts are unchanged.
- **Cached, non-blocking session discovery.** The picker shares in-flight
  `session.list` requests and caches the result for five seconds, so reopening
  it is immediate. Workspace lookup is optional, cached, and bounded to 300 ms;
  if the registry is slow, the picker groups by `cwd` instead of waiting.
- **Button-motion mouse tracking by default.** All-motion tracking (`1003`) is
  disabled to avoid a flood of motion events in Herdr and iTerm2. Set
  `DSH_ATTACH_FULL_MOUSE=1` if you need it.
- **Long streaming answers.** Above 40,000 characters, the live phase renders
  only the tail as plain text. The complete Markdown is laid out once when the
  message is finalized, so a growing message does not make every streaming tick
  take seconds.

Reference measurements from the project:

- Synthetic 900-row mixed transcript: about 25 ms/frame uncached, about
  0.1 ms/frame with the cache, same process and width.
- Real long session of about 300 messages: about 2.5 ms/frame warm, measured
  with `DSH_ATTACH_PERF=1`.

### Measure it yourself

```sh
DSH_ATTACH_PERF=1 dsh-attach -s <session-id>
```

With `DSH_ATTACH_PERF=1`:

- `frame-stats` is logged every 50 frames with average time, maximum time, and
  heap usage;
- `input-latency` is logged for each key event;
- `loop-lag` is logged when the event loop is blocked for more than 100 ms.

The log also records `transcript-trim` events with the number of dropped and
kept rows, `subagents` / `subagents-error` events for refresh failures, and
`subagent-control` events with the action, child id, and success flag for
follow-up and stop requests. Each session picker open logs a
`session-picker` event with elapsed milliseconds, the session count, and whether
workspace lookup fell back to `cwd` grouping.

### Host capabilities

- Host plugin 0.11.7 and later expose the lightweight `subagent.summary`, which
  avoids sending the full session list to the client every few seconds.
- Host plugin 0.13 and later include active subagent IDs in the summary, which
  the bottom peek uses.
- Hosts that advertise `history.pagination` expose the `history.events` route,
  which backs `Ctrl+R`/`/history`; clients show a warning when the capability is
  absent.
- Lifecycle capabilities are advertised only when the Host service exists:
  `session.fork` (Session controller), `session.archive` (Workspace controller),
  `session.pin` (Workspace controller), and `session.presets` (Agent-preset
  registry). `/session` reports the missing capability instead of guessing.
- `session.presets` is absent when the Agent-preset registry is not mounted;
  new sessions then use the Host default.
- DSH exposes no Session deletion. `session.archive` is the supported
  lifecycle end state, and `/session delete` reports that limitation.
- Hosts that expose `ctx.subagents.prompt`/`interruptByParent` advertise
  `subagent.continue` and `subagent.interrupt` in the welcome; the picker shows
  `c continue` / `x stop` only for those capabilities. A missing capability is
  reported as an unsupported action, not a route failure.
- Hosts that expose `GoalService.complete` advertise the `goal.complete`
  capability; the local `/goal complete` action uses that route. Older bridges
  report the action as unsupported, while pause/resume/edit/clear still go
  through the Host command registry.
- Older Hosts automatically fall back to `session.list`; counts still work, but
  refreshes are less frequent and cost more.
