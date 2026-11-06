# Usage

## TUI layout

The alternate-screen UI has six regions:

```text
header      connection dot · DSH · session title · agent badge · cwd
transcript  user messages, Markdown answers, reasoning, tool calls and results
peek        up to two compact running-subagent summaries
queue       pending inbox messages from other clients or before attach
activity    turn/step state, queue count, interactive prompts
editor      prompt composer and floating command/file completions
footer      shortcuts, context/token usage, permission state
```

The header and activity line update as the Host streams turns, steps, tool
calls, model selection changes, todos, and goals. A blocked goal is shown in the
activity line with its reason, for example `goal blocked · needs input`.
The client also reads the process-local goal activation: an `active` goal that
is `disarmed` is shown as `goal inactive`, matching the Web GUI's "Inactive
Goal"; `goal active` is reserved for an armed goal.

### Step groups

Thinking and tool calls inside one turn/step are collected into one collapsible
step group instead of being printed as separate transcript rows. The hierarchy
has two levels:

```text
▾ ◐ Running commands and read files · npm test
  ✓ bash npm run build
  ◐ bash npm test
  ✻ Think · check the failing assertion
  ✓ read README.md
```

The running group expands automatically and shows child tools and thinking in
compact form. `Ctrl+O` expands tool arguments/output, and `Ctrl+T` expands
thinking; neither key opens or closes the group itself. A finished group
collapses to a summary such as
`▸ ✓ Ran commands and edited files`, and `Ctrl+G` expands all groups for manual
inspection. Failures add a `failed` count.

The group label reflects the tools in the step: `commands`, `edited files`,
`read files`, or a combination. Thinking-only activity remains a standalone
reasoning row. Its collapsed preview follows the latest non-empty reasoning
line and shows the live character count, like `tail -f`; `Ctrl+T` opens the full
reasoning block.

## Sessions

### Pick a session

Running `dsh-attach` without `--session` opens the session picker. Every
session is one flat row: the session title and workspace name share the first
column, followed by a flexible directory column, a right-aligned subagent-count
column, and a right-aligned age column. The directory column absorbs spare
width and preserves both ends of a long path. The selected row's complete
workspace path is shown below the list. The current session is selected first
and marked with `★`; running sessions use `●`.

Typing or pressing `/` enters incremental search over titles, workspace names,
working directories, and descriptions. There are no collapsible workspace
headers, so every matching session is visible immediately.

Session discovery can take a moment on a large history. If it takes longer than
about 120 ms, the picker shows a small loading panel. Results are cached briefly
and in-flight requests are shared; workspace lookup is best-effort and bounded
so a slow Workspace registry falls back to `cwd` grouping instead of holding up
the list.

In the picker's navigation mode, press `n` to create a session in the client
process's working directory. Start `dsh-attach -C <path>` to override that for
the whole run. Blank sessions are hidden unless they are running or already
have subagents; archived sessions are hidden until you press `Ctrl+A` to show
them. Pinned sessions are marked with `◆` and sort immediately after the
current session.

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
/session new [cwd]        create a session in cwd, or in the client working directory
/session rename <title>   rename the current session
```

From the command line, `--new` creates a session and `-C`/`--cwd` chooses its
working directory.

## Prompts

Press `Enter` to submit the composer contents. Submitting also returns the
transcript to the live edge and resumes auto-follow if you had scrolled back.
While a turn is running, the prompt is queued by default; the Host delivers it
when the current turn is ready. The transcript shows a local echo marked `queued` until the Host claims
the message. Pending messages from any attached client appear in the queue
panel above the composer, and `/status` reports the current count.

Use a slash command to change delivery:

```text
/steer <text>     interrupt the current turn and insert a steering message
/queue <text>     queue a message while the current turn runs
/queue            manage the pending queue
```

The queue manager lists this session's pending messages. `Enter` opens the full
message, `e` edits it in place, `s` sends a next-turn message into the current
turn as steering, and `d` twice removes it. `r` refreshes, and `Esc` closes the
manager. Messages already in the next-step lane are steering already; they
cannot be sent again.

`/steer` is the only operation that interrupts the current turn and inserts a
message. `/cancel` stops the running turn without adding a message; pressing
`Esc` twice within 750 ms does the same. The first `Esc` shows
`esc again to interrupt` in the activity line.

Press `Ctrl+V`/`Cmd+V` (native clipboard paste), `Ctrl+Shift+V`, or run `/image paste`
to read an image from the system clipboard. `Ctrl+V` checks for an image first;
if the clipboard has no image, it inserts clipboard text instead, so it behaves
like a normal paste on terminals that deliver Ctrl+V to the application. The
image name appears above the composer; `/image clear` removes pending images.
Images are sent with the next prompt, including an image-only prompt. Up to eight
images can be attached at once. macOS uses `pngpaste` when available and
otherwise AppleScript; Linux uses `wl-paste` or `xclip`; Windows uses
PowerShell's `System.Windows.Forms.Clipboard`. If the terminal consumes `Ctrl+V`
or `Ctrl+Shift+V`, use `/image paste`.

File upload and `@` file indexing are not wired into the client.

## Transcript and history

When a session opens, the Host follows it and sends a snapshot of recent
history plus live frames. The snapshot is capped at the most recent **300
messages** by default; earlier pages are not fetched yet. If the Host reports
more history, or the client trims old rendered rows, the activity line and
`/status` say so instead of silently pretending the visible transcript is
complete.

Scrolling and navigation:

- `PgUp`/`PgDn`, `Shift+PgUp`/`Shift+PgDn`, `Alt+V`, and
  `Ctrl+Alt+B`/`Ctrl+Alt+F` move through the transcript.
- `Ctrl+Home` jumps to the top of the loaded history; `Ctrl+End` jumps to the
  bottom.
- `Ctrl+L` returns to the newest message and re-enables auto-follow.
- The mouse wheel scrolls history. Scrolling up suspends auto-follow, so new
  streaming output does not pull the view back to the bottom.
- `/find <text>` jumps to the first loaded match; `/find` opens an incremental
  search over the loaded transcript. Collapsed groups are searched as they
  render, so expand a group with `Ctrl+O`/`Ctrl+G` to search its children.

While following, the transcript is bounded to **5,000 rendered rows**. Older
rows are dropped as new ones arrive. Trimming is deferred while you are scrolled
up, but a hard bound of 10,000 rows still prevents unbounded memory growth. The
background-job roster keeps live jobs and the 200 most recent settled jobs.

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

- `/session resume` session titles and IDs;
- `/job output` and `/job kill` job IDs;
- `/subagent preview` the preview count;
- `/model` provider/model pairs and reasoning-effort variants;
- `/permission` sandbox presets;
- relative file paths from the current session's working directory.

`/permission` with no argument opens a preset picker. `/model` lists one row per
reasoning effort when the Host catalog advertises them; the current default is
marked `(default)`.

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
| `y`, `Y` | Allow once. |
| `n`, `N` | Reject. |
| `Enter`, `d`, `D`, `e`, `E` | Open full request and command details. |
| `Esc` | Detach this terminal from the request; another client or timeout may answer it. |

`Enter` opens the details view instead of allowing, so the high-impact action
always requires an explicit `y`. The panel previews at most the first few lines
of the command. Press `d` (or `e`, or `Enter`) to open the complete request
text, command, and raw arguments in a read-only, scrollable view. Use
`PgUp`/`PgDn`, `Ctrl+U`/`Ctrl+D`, or the arrow keys to scroll; `Home`/`End` and
`g`/`G` jump to the ends; `Esc` or `q` returns to the approval panel. When the
tool arguments carry a target path or old/new text, the details also show the
target and proposed edit, plus the working directory, sandbox and current model.

The default routing mode is `tui`: while a terminal is watching the session,
the request is offered to the terminal. The client sends an `activity`
heartbeat every 20 seconds, so a long turn does not make the terminal look
inactive. A terminal that actually displays the panel acknowledges it; an
unacknowledged request is handed to the next Host listener after
`approvalGraceSeconds`, typically the Web GUI when one is connected. If no Web
client is available, the request is released from the
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
| `Enter` | Select the highlighted option and advance; for a free-text question, submit the focused input. |
| `1`–`9` | Jump to an option by number. |
| `c` | Enter custom text. |
| `s` | Skip the whole batch and immediately return `skipped` to the Host. |
| `Esc` | Close the TUI panel and release the question from this client. |

Questions without options open with a focused text input. For questions with
options, `c` opens custom text; `Enter` submits it and returns to the option list,
while `Esc` cancels the custom text. On a free-text question, `Esc` dismisses the
panel.

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

`/subagent list` lists the lineage under the current session. Active subagents are
listed first; within the same status, newer children come first. `/agents` and
`/agents-preview` remain accepted as compatibility aliases. Indentation shows
nesting depth; `Enter` opens a subagent, and `/subagent parent` returns to the direct
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
  sessions, when `/subagent peek` is disabled, or when the TUI exits.
- `/subagent peek` toggles the feature; it is enabled by default.
- Newer Hosts return active subagent IDs and short catalog labels in
  `subagent.summary`. When labels are missing, the client resolves them from
  `subagent.list` and caches them; counts fall back to `session.list` when the
  summary route is unavailable.
- Use `/subagent list` or `/subagent preview` when you need the full execution view.
  `/subagent preview` opens managed Herdr plugin panes and needs a one-time
  `herdr plugin link`; see [Herdr integration](herdr.md).

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
original invocation. `/session resume` opens the picker or takes an ID; `--reattach`
goes directly to the given session.

## Multiple TUI windows

Under the default `tui` mode, approval and question requests are broadcast to
every TUI watching the same session. The first client to answer wins, and the
panels close in the other clients. On a Host that does not broadcast (older
plugin builds), a request may go to only one connection; keep a single
`dsh-attach` window open or upgrade the Host.

## Background jobs

When the Host exposes its job registry, `/job list` lists the current session's
background and long-running jobs, running first. The activity line shows a
`jobs N` count for live jobs. Select a job with `Enter` to open its live output;
`r` refreshes the roster, and pressing `k` twice within three seconds stops the
selected job.

The direct commands are `/job output <job-id>` and `/job kill <job-id>`. The
output panel shows the job's command/label above its read-only output, follows
new output at the bottom, and scrolls with the usual page keys. Press `Enter`
or `d` for a full read-only detail view with the untruncated command, id, owner,
timing and progress; this is the way to read a command that wraps or is too long
for the header. Closing the output with `Esc`/`q` returns to the job list when it
was opened from `/job list` (or to the composer for a direct `/job output`). It reads
the Host's observer cursor, which is separate from the model's `job_output`
cursor, so viewing a job does not consume output the agent still needs.

If the Host predates the job bridge or was composed without a job registry,
`/job list` reports that background jobs are unavailable. Restart the Host after
upgrading the plugin to load the new routes.

## Attaching to a live agent

Opening a session subscribes to its live stream. You can attach in the middle
of a turn and see the in-progress assistant text, reasoning, and tool state.
Queued prompts enter the same Host queue as prompts from the Web GUI.

A terminal follows one session at a time. Other sessions continue running in
the Host; switching sessions in the TUI does not stop them. Press `Ctrl+C`
once while idle, or twice within two seconds while a turn or panel is active
(or run `/quit`) to detach the TUI; this never cancels a running turn.

If the Host restarts, the client marks the connection as lost, retries with
backoff, and reopens the current session after the new endpoint appears. Run
`/reconnect` to force a fresh attempt immediately, for example after starting
the Host again. This also covers restarting the DeepSeek Harness desktop app.
The reconnect runs in the background; `Ctrl+C` still exits the client (once idle, or twice while a turn or panel is active).

If the last turn was durably closed as `interrupted` during the restart, the
client sends one continuation prompt after reopening the session. The prompt
has a stable request id, so multiple reconnecting TUI clients do not enqueue
duplicates. Set `DSH_ATTACH_AUTO_RESUME=0` to disable this behavior. Automatic
continuation can repeat side-effecting tool work; the recovery prompt tells the
model to inspect state first and avoid repeating completed work. Approvals or
questions that were pending only in the old Host process may not survive the
restart.

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
