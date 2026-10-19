# Usage

## TUI layout

The alternate-screen UI has six regions:

```text
header      connection dot · DSH · session title · agent badge · cwd
transcript  user messages, Markdown answers, reasoning, tool calls and results
peek        up to two compact running-subagent summaries
activity    turn/step state, queue state, interactive prompts
editor      prompt composer and floating command/file completions
footer      shortcuts, context/token usage, permission state
```

The header and activity line update as the Host streams turns, steps, tool
calls, model selection changes, todos, and goals.

## Sessions

### Pick a session

Running `dsh-attach` without `--session` opens the session picker. The list is
grouped by durable Workspace, with a `cwd` fallback for sessions that the
Workspace registry does not account for. Each group header shows the workspace
path, session count, agent count, and running count.

The picker starts compact: the current group, groups with running sessions, and
the most recently used group are expanded. Typing or pressing `/` enters
incremental search over titles, working directories, and descriptions, and
expands matching groups. Group headers are marked with `▸`/`▾`, the current
session with `★`, and running sessions with `●`.

The first row is **New session**, which creates a session in the client
process's working directory. Start `dsh-attach -C <path>` to override that for
the whole run. Blank sessions are hidden unless they are running or already
have subagents; archived sessions are hidden.

### Open a session directly

```sh
dsh-attach -s <session-id>
dsh-attach --reattach <session-id>
```

`--reattach` is an alias for `--session`. It is called "reattach" because the
client attaches to an existing Host and session; it does not resume a new agent
process.

### Create or rename

Inside the TUI:

```text
/new [cwd]        create a session in cwd, or in the client working directory
/rename <title>   rename the current session
```

From the command line, `--new` creates a session and `-C`/`--cwd` chooses its
working directory.

## Prompts

Press `Enter` to submit the composer contents. While a turn is running, the
prompt is queued by default; the Host delivers it when the current turn is
ready. The transcript shows a local echo marked `queued`.

Use a slash command to change delivery:

```text
/steer <text>     interrupt the current turn and insert a steering message
/queue <text>     queue a message while the current turn runs
```

`/steer` is the only operation that interrupts the current turn and inserts a
message. `/cancel` stops the running turn without adding a message.

Prompt text is sent to the Host as text content only. Images, attachments, file
uploads, and `@` file indexing are not wired into the client.

## Transcript and history

When a session opens, the Host follows it and sends a snapshot of recent
history plus live frames. The snapshot is capped at the most recent **300
messages**; earlier pages are not fetched yet.

Scrolling and navigation:

- `PgUp`/`PgDn`, `Shift+PgUp`/`Shift+PgDn`, `Alt+V`/`Ctrl+V`, and
  `Ctrl+Alt+B`/`Ctrl+Alt+F` move through the transcript.
- `Ctrl+Home` jumps to the top of the loaded history; `Ctrl+End` jumps to the
  bottom.
- `Ctrl+L` returns to the newest message and re-enables auto-follow.
- The mouse wheel scrolls history. Scrolling up suspends auto-follow, so new
  streaming output does not pull the view back to the bottom.

While following, the transcript is bounded to **8,000 rendered rows**. Older
rows are dropped as new ones arrive. Trimming is deferred while you are scrolled
up, so the view does not jump.

Prompt history is kept in the editor for the current run, up to **100**
entries. It is not persisted across client restarts. The composer stores a
draft separately, so browsing history and returning to the draft does not lose
text.

## Commands and completion

A `/` at the start of a line opens the command list. Continue typing to filter;
`Tab` completes into the editor without executing, and `Enter` completes a
slash command and executes it. Path completions accept with `Enter` without
submitting the prompt. For commands with arguments, completing first and typing
the argument second is the safer workflow.

Completion also covers:

- `/resume` session titles and IDs;
- `/model` provider/model pairs;
- relative file paths from the current session's working directory.

The completion panel floats above the composer and never changes the editor's
height.

Local commands are handled by the TUI. Any other slash command is first offered
to the Host command registry (`ctx.commands.execute`). If the registry does not
know it, or the Host is too old to expose command execution, the line is sent
as a normal prompt. Host commands do **not** become model prompts when they are
executed.

See [Keys and commands](keybindings.md) for the complete list.

## Approvals

An `approval/request` from the Host appears as a modal panel with the tool name,
reason, and command preview.

| Key | Action |
|---|---|
| `y`, `Y`, `Enter` | Allow once. |
| `n`, `N`, `Esc` | Reject. |

The default routing mode is `tui`: while a terminal is watching the session,
the request is offered to the terminal. The client sends an `activity`
heartbeat every 20 seconds, so a long turn does not make the terminal look
inactive. If the panel is not answered within `approvalGraceSeconds`, the Host
hands the request to the next Host listener, typically the Web GUI when one is
connected. If no Web client is available, the request is released from the
terminal path rather than held forever.

Other modes are described in [Configuration](configuration.md):

- `auto` prefers the terminal after recent activity or when no Web client is
  connected.
- `web` leaves approvals entirely to the Web GUI.
- `off` disables terminal approvals.

If the bridge owns the request type and a terminal attaches after the request
was emitted, the Host replays the pending approval or question while it is still
pending. This requires a Host plugin that keeps pending interactions in memory
(0.8.0 and later). If the Web UI was already showing the same request, whichever
client answers first wins.

## Questions

`ask_user_question` requests support single select, multi select, custom text,
and plan approval. Answers are submitted as one batch when the question flow
completes.

| Key | Action |
|---|---|
| `Up`/`Down`, `Ctrl+P`/`Ctrl+N` | Move between options. |
| `Space` | Toggle the highlighted option (multi select) or select it (single select). |
| `Enter` | Select the highlighted option and advance; with no options, enter custom text. |
| `1`–`9` | Jump to an option by number. |
| `c` | Enter custom text. |
| `s` | Skip the whole batch and immediately return `skipped` to the Host. |
| `Esc` | Close the TUI panel and release the question from this client. |

In custom-text mode, `Enter` submits the text and returns to the option list;
`Esc` returns without submitting.

`Esc` does not silently answer the question. It detaches the panel from the
terminal and lets the Host's remaining flow (for example the Web GUI) or the
question timeout resolve it. Use `s` when you want to skip the batch
immediately.

## Subagents

The parent session header shows the number of subagents in the whole lineage.
While any are running, the badge shows running/total, for example
`agents 1/27`. The activity line uses the same numbers:

```text
● subagents running · agents 1/27         parent turn finished, children active
✻ working · turn 12 · step 2 · agents 1/27  parent turn and children active
● ready · agents 27 idle                  everything is idle
```

`/agents` lists the lineage under the current session. At every level, running
children sort before idle ones and newer children come first. Indentation shows
nesting depth; `Enter` opens a subagent, and `/parent` returns to the direct
parent. Subagent history is read-only and the footer is marked
`subagent · read-only`.

Subagent counts come from the session list and are attributed to the top-level
session through the parent chain, so they also work on Hosts without a catalog
route. Opening subagent history requires a Host plugin that supports
`session.open` with a subagent address (0.10.0 and later). Listing and counts
work on older Hosts.

Not supported from the TUI:

- dispatching a new subagent;
- continuing or interrupting a continuable child;
- routing a subagent's approval or question to the parent session's terminal.

Use the main agent's delegation tools or the Web GUI for those operations.
`/cancel` refuses to cancel when the current view is a subagent history.

### Subagent peek

When subagents are running, the parent TUI shows up to two compact peeks above
the activity line:

```text
◈ reviewer running
  ⚙ bash npm test
  ✓ 24 passed
◈ builder running
  … editing src/foo.ts
```

- The header shows the Host's short subagent catalog label (for example
  `Verify worktree cwd`), falling back to the session title or ID when no label
  is available.
- Each peek keeps only the latest **2 lines**; it does not render the full
  transcript or Markdown.
- Each peek uses an **additional Unix socket connection**, not a new process.
  At most two are open.
- Text updates are throttled to about 10 per second; the parent UI repaints at
  about 3 per second.
- Peeks close automatically when the child stops running, when you switch
  sessions, when `/peek` is disabled, or when the TUI exits.
- `/peek` toggles the feature; it is enabled by default.
- Newer Hosts return active subagent IDs and short catalog labels in
  `subagent.summary`. When labels are missing, the client resolves them from
  `subagent.list` and caches them; counts fall back to `session.list` when the
  summary route is unavailable.
- Use `/agents` or `/agents-preview` when you need the full execution view.

## Reattach hint

On a normal exit, when a session is open, the client prints:

```text
Reattach with: dsh-attach --reattach <session-id>
```

The hint is printed only for `Ctrl+C`, `/quit`, `/exit`, and only when `stderr`
is a TTY. It is suppressed for signal exits, stdin close, crashes, and nonzero
exit codes, because the terminal may already be gone. `DSH_ATTACH_NO_EXIT_HINT=1`
disables it entirely.

The hint preserves `--profile`, `--endpoint`, and `--theme dark` from the
original invocation. `/resume` opens the picker or takes an ID; `--reattach`
goes directly to the given session.

## Multiple TUI windows

Under the default `tui` mode, approval and question requests are broadcast to
every TUI watching the same session. The first client to answer wins, and the
panels close in the other clients. On a Host that does not broadcast (older
plugin builds), a request may go to only one connection; keep a single
`dsh-attach` window open or upgrade the Host.

## Attaching to a live agent

Opening a session subscribes to its live stream. You can attach in the middle
of a turn and see the in-progress assistant text, reasoning, and tool state.
Queued prompts enter the same Host queue as prompts from the Web GUI.

A terminal follows one session at a time. Other sessions continue running in
the Host; switching sessions in the TUI does not stop them. `Ctrl+C` or `/quit`
only detaches the TUI and never cancels a running turn.

There is no automatic reconnect. If the Host restarts, the client marks the
connection as lost and shows `Host connection closed. Press ctrl+c to exit.`;
press `Ctrl+C` and start `dsh-attach` again.

## Terminal focus and mouse

When the terminal reports focus loss, the composer hides the block cursor that
represents an empty input. Focus-in restores it, so switching to another
application does not leave a bright cursor-like block behind. Focus reporting is
enabled only while mouse reporting is enabled.

Mouse behavior:

- By default, the client requests button-motion tracking (`1002`) rather than
  all-motion tracking (`1003`). Wheel, click, and drag selection work without a
  flood of motion events in terminals such as Herdr and iTerm2.
- `DSH_ATTACH_FULL_MOUSE=1` restores full all-motion tracking.
- `DSH_ATTACH_NO_MOUSE=1` disables mouse reporting and focus reporting, which is
  useful when isolating terminal focus issues.

SSH works because the client runs on the remote machine next to the Host; no
extra port is opened. The remote user must match the Host user.
