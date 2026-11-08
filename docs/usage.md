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

The running turn's work expands automatically and shows its step groups and
child tools in compact form. A finished turn collapses to one summary such as
`▸ ✓ Completed at 23:44:23 · 2m 13s · 42 tool calls`. The running header
shows `started 23:42:10 · 2m 13s`; the activity line also shows the start time
and live elapsed time, and after completion shows `last completed 23:44:23`.
Failures add a `failed` count.

There is one detail control instead of separate thinking/tool/group toggles:

- `compact`: fold running and completed turn work;
- `standard` (default): keep the running turn open and fold completed turns;
- `verbose`: expand turn work, tools, and reasoning.

`Ctrl+G` cycles these levels; `/detail compact|standard|verbose` sets one
directly. Inside an expanded turn, each step group carries its own label such as
`Ran commands and edited files`. Thinking-only activity remains a standalone
reasoning row. Its collapsed preview follows the latest non-empty reasoning
line and shows a compact, right-aligned character count, like `tail -f`.
reasoning block.

## Goals and plan mode

The session goal and plan mode are rendered in the activity line and the
`/status` panel, and both have first-class local commands.

```text
/goal                       show phase, rounds, activation, blocker and next actions
/goal <objective>           create and arm a goal
/goal create <objective>    create explicitly
/goal edit [objective]      edit the objective; without text, opens an editor
/goal pause                 pause and disarm continuation
/goal resume                resume or rearm a stopped goal
/goal complete              mark the goal complete (asks for confirmation)
/goal clear                 clear the goal and keep its durable history (asks for confirmation)
```

`complete` and `clear` open a confirmation panel: press `y` to confirm, or
`n`/`Enter`/`Esc` to cancel. Goal completion uses the Host's `goal.complete`
capability; an older bridge reports that it is unsupported instead of guessing
or sending the command to the model.

```text
/plan                       enter plan mode
/plan <message>             enter plan mode and steer that instruction
/plan enter [message]       explicit form of the two above
/plan off, /plan exit       leave plan mode
/plan status                show active/pending state and the plan-review hint
```

DSH has no separate plan-edit or plan-approve slash command. A plan is written
by the model and presented through `exit_plan_mode`; the terminal renders that
as the normal question panel with `Approve` and `Keep planning` options.
`/plan approve` explains this and points at the open review instead of sending
text to the model.

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
the whole run. The same mode offers `f` to fork the selected session, `a` to
archive it (or unarchive an archived row), and `p` to pin or unpin it. Blank
sessions are hidden unless they are running or already have subagents;
archived sessions are hidden until you press `Ctrl+A` to show them. Pinned
sessions are marked with `◆` and sort immediately after the current session.

### Open a session directly

```sh
dsh-attach -s <session-id>
dsh-attach --reattach <session-id>
```

`--reattach` is an alias for `--session`. It is called "reattach" because the
client attaches to an existing Host and session; it does not resume a new agent
process.

### Create, fork, archive, and pin

Inside the TUI:

```text
/session new [cwd] [--preset <id>]   create a session in cwd, or in the client working directory
/session rename <title>              rename the current session
/session fork [id]                   fork a session at its latest completed turn and open the child
/session archive [id] [--stop]       archive a session, or stop its running work and archive it
/session unarchive <id>              restore an archived session
/session pin [id]                    pin a session
/session unpin [id]                  unpin a session
```

Commands that take `[id]` operate on the open session when the id is omitted.
Forking uses the Host's latest-completed-turn boundary. Archive is the
supported lifecycle end state: DSH does not expose Session deletion, so
`/session delete` reports that limitation rather than attempting one. Archiving
a Session with running work fails with the Host's activity description; retry
with `--stop` to stop that work first. Archiving the open Session leaves it
readable, but further turns are blocked until it is unarchived.

From the command line, `--new` creates a session and `-C`/`--cwd` chooses its
working directory.

### Agent presets

When the Host mounts the Agent-preset registry, the client can disclose and
choose the preset used by *new* sessions:

```text
/session presets            show the roster, the Host default, and the next-session choice
/session preset [id]        choose the next-session preset, or open a picker
/session new --preset <id>  create one session with an explicit preset
/session preset default     return to the Host default
```

The roster comes from the Host's `session.presets` route; a preset that failed
to activate stays visible and is marked `unavailable`. Existing sessions keep
the preset they started with. `/status` shows both the current session's
`preset` and the `new preset` used by the next `/session new`.

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
messages** by default. When the Host reports that older messages remain, the
activity line says `earlier history not loaded · ctrl+r loads older`.

Press `Ctrl+R` (or run `/history`, alias `/earlier`) to fetch one older page.
Pages are read from DSH's durable Session log with an exclusive sequence cursor,
so a page is chronological and never overlaps the rows already on screen. The
view stays anchored: previously visible content keeps its place while the older
rows are inserted above it, and auto-follow stays suspended until `Ctrl+L`,
`Ctrl+End`, or sending a prompt returns to the live edge. Live events that
arrived in the meantime are still appended normally.

The activity line and `/status` report whether older history remains, how many
older pages are loaded, and how many rows transcript trimming has dropped. If
rows at the front were trimmed, the next page is fetched before the oldest
**still rendered** event, so the trimmed span is restored instead of leaving a
silent gap. Paging stops at a 25,000-row safety ceiling.

Scrolling and navigation:

- `PgUp`/`PgDn`, `Shift+PgUp`/`Shift+PgDn`, `Alt+V`, and
  `Ctrl+Alt+B`/`Ctrl+Alt+F` move through the transcript.
- `Ctrl+Home` jumps to the top of the loaded history; `Ctrl+End` jumps to the
  bottom.
- `Ctrl+L` returns to the newest message and re-enables auto-follow.
- `Ctrl+R` loads older history without moving the viewport.
- The mouse wheel scrolls history. Scrolling up suspends auto-follow, so new
  streaming output does not pull the view back to the bottom.
- `/find <text>` jumps to the first loaded match; `/find` opens an incremental
  search over the loaded transcript, including pages loaded from history.
  Folded work stays searchable; use `/detail verbose` or cycle with `Ctrl+G`
  to inspect matched command rows.

While following, the transcript is bounded to **5,000 rendered rows**. Older
rows are dropped as new ones arrive. Trimming is deferred while you are scrolled
up, but a hard bound of 10,000 rows still prevents unbounded memory growth.
Loading older pages may exceed those bounds up to the paging ceiling. The
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

- `/session resume`, `/session fork`, `/session archive`, `/session unarchive`,
  `/session pin`, and `/session unpin` session titles and IDs;
- `/session preset` and `/session new --preset` Host Agent-preset ids;
- `/job output` and `/job kill` job IDs;
- `/subagent preview` the preview count;
- `/skill show` and `/skill run` user-invocable skill names;
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

## Todos

The model's `todo_write` plan is visible in the activity line as a completed
count and the current item. `/todo` (or `/todos`) opens the full list with
`○` pending, `◐` in-progress, and `✓` completed markers; the panel refreshes
when the model writes a new list.

## Skills

The Host's skill catalog is available without leaving the TUI. `/skill` or
`/skill list` shows every skill the user may invoke; `/skill show <name>` opens
its full instructions and provider/path metadata; `/skill run <name>` submits
the canonical `/<name>` prompt so the Host injects the skill.

User-invocable skill names also appear in the `/` completion list, after local
and Host commands. Names shadowed by an existing local or Host command are
omitted from that top-level list but remain available through `/skill run`.

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
parent. The history view is read-only and the footer is marked
`subagent · history read-only`; control actions are addressed from the picker or
the `/subagent` commands instead of typing into the child transcript.

### Subagent control

The picker shows `c continue` and `x stop` on rows where the Host reports the
action. The same operations are available as commands:

```text
/subagent continue <id> <message>   # deliver a follow-up (Queue by default)
/subagent continue <id>             # open the follow-up editor
/subagent interrupt [id]            # stop the current turn after confirmation
/subagent stop [id]                 # alias for interrupt
/subagent cancel [id]               # alias for interrupt
```

`/subagent continue` requires a **continuable** child whose direct parent is
live. The Host accepts the message into the child's inbox; it does not wait for
a reply. A running child receives it at its next step boundary through Steer,
while an idle child starts a new turn. A one-shot or external child cannot be
continued. The TUI sends text-only follow-ups; use the Web GUI for image
content.

`/subagent interrupt`, `stop`, and `cancel` are aliases for DSH's single
user-facing stop primitive. They stop only the selected child's current work.
A local activation keeps its inbox, descendants, and later follow-ups; an
external execution stops permanently. The Host acknowledges the request, not
quiescence. The selected child must be running; a settled target is an accepted
no-op. The command asks for confirmation with an explicit `y`; `n`, `Enter`,
and `Esc` cancel.
`/cancel` and `Esc` `Esc` in a subagent history view use the same confirmation.

If the selected row is a nested child, its direct parent must be a live Host
Agent for continuation. If that parent is idle but resident, the follow-up
still works; if the parent is not live, the TUI reports that it must be opened
first. Interrupt is addressed through the durable parent and does not need the
parent Agent to be live.

Subagent counts come from the session list and are attributed to the top-level
session through the parent chain, so they also work on Hosts without a catalog
route. Opening subagent history requires a Host plugin that supports
`session.open` with a subagent address (0.10.0 and later). Listing and counts
work on older Hosts. Control requires a Host that advertises
`subagent.continue` / `subagent.interrupt`; without those capabilities the
picker and commands report that the Host exposes no control route.

Not supported from the TUI:

- dispatching a new subagent;
- releasing or deleting a child activation separately from `interrupt`
  (DSH exposes no user-facing termination remote method);
- routing a subagent's approval or question to the parent session's terminal.

Use the main agent's delegation tools or the Web GUI for those operations.

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
