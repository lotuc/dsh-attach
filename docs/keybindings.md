# Keys and commands

Local command names are case-insensitive. Local commands are handled by the
TUI; other slash commands are offered to the Host command registry before
falling back to a normal prompt.

## Global keys

| Key | Action |
|---|---|
| `Ctrl+C` | Quit immediately when idle with no panel open. While a turn is running or a panel is open, press twice within two seconds. Running Host work is not stopped; `/quit` always exits immediately. |
| `Esc` `Esc` | Interrupt the running turn (two presses within 750 ms). The first press shows `esc again to interrupt`. In a subagent history view this opens the stop confirmation for that subagent. |
| `Ctrl+G` | Cycle transcript detail: `compact` → `standard` → `verbose`. |
| `/detail [level]` | Set `compact`, `standard`, or `verbose` directly; no argument cycles. |
| `Ctrl+L` | Return to the newest message and resume auto-follow. |
| `Ctrl+R` | Load one older page of session history; the reader's scroll position stays anchored. |
| `PgUp` | Scroll the transcript up one page. |
| `Shift+PgUp`, `Alt+V`, `Ctrl+Alt+B` | Alternative scroll-up bindings. |
| `PgDn` | Scroll the transcript down one page. |
| `Shift+PgDn`, `Ctrl+Alt+F` | Alternative scroll-down bindings. |
| `Ctrl+Home` | Jump to the top of the loaded history. |
| `Ctrl+End` | Jump to the bottom of the loaded history. |
| Mouse wheel | Scroll the transcript. |

The transcript page and jump keys are consumed only when no modal panel or
picker is open. In a panel, the same keys belong to that panel. `Esc` closes a
panel, picker, or completion list first; `Esc` `Esc` interrupts only after those
are closed.

## Composer and text editing

| Key | Action |
|---|---|
| `Enter` | Send the prompt and return the transcript to the newest message. While a turn is running, the prompt is queued. |
| `Ctrl+V` / `Cmd+V` | Native clipboard paste: attach an image when the clipboard contains one, otherwise insert clipboard text. |
| `Ctrl+Shift+V` | Explicit clipboard-image paste, with text fallback; `/image paste` is the fallback when the terminal consumes this key. |
| `Shift+Enter`, `Ctrl+J` | Insert a newline instead of sending. |
| `Up`, `Ctrl+P` | Move up; on the first line at column 0, or while browsing history, go to the previous prompt. |
| `Down`, `Ctrl+N` | Move down; on the last line while browsing, go to the next prompt. |
| `Left`, `Ctrl+B` | Move one character left. |
| `Right`, `Ctrl+F` | Move one character right. |
| `Alt+B`, `Ctrl+Left`, `Alt+Left` | Move one word left. |
| `Alt+F`, `Ctrl+Right`, `Alt+Right` | Move one word right. |
| `Home`, `Ctrl+A` | Move to the start of the line. |
| `End`, `Ctrl+E` | Move to the end of the line. |
| `Ctrl+K` | Delete to the end of the line. |
| `Ctrl+U` | Delete to the start of the line. |
| `Ctrl+W`, `Alt+Backspace` | Delete the previous word. |
| `Alt+D`, `Alt+Delete` | Delete the next word. |
| `Ctrl+D`, `Delete` | Delete the character under the cursor. |
| `Backspace` | Delete the character before the cursor. |
| `Ctrl+Y` | Yank the last killed text. |
| `Alt+Y` | Cycle the kill ring. |
| `Ctrl+-` | Undo. |
| `Ctrl+]` | Jump forward to a character. |
| `Ctrl+Alt+]` | Jump backward to a character. |

The prompt history is per client run and capped at 100 entries. Reaching the
top or bottom of the composer with the arrow keys enters or leaves history
browsing; returning past the newest entry restores the draft.

## Command completion

| Key | Action |
|---|---|
| `/` at the start of a line | Open the command list. |
| Printable text after `/` | Filter the command list. |
| `Tab` | Complete the selection into the composer without executing it. |
| `Enter` | Complete the selection. Slash commands are then executed; path completions are inserted without submitting. |
| `Ctrl+N`, `Ctrl+P`, `Up`, `Down` | Move through completion items. |

For commands with arguments, complete the command first with `Tab`, then type
the argument. `/session resume` completes session titles and IDs; `/job output`
and `/job kill` complete job IDs; `/subagent` completes `list`, `continue`,
`interrupt`, `stop`, `cancel`, `preview`, `parent`, and `peek`, and
`/subagent preview` completes the count;
`/model` completes `provider/model` pairs; `/goal` offers `status`, `create`,
`edit`, `pause`, `resume`, `complete`, and `clear`; `/plan` offers `status`,
`enter`, `exit`, and `approve` (which points at the review panel); and
`/permission` offers `read-only`, `workspace-write`, `danger-full-access`, and
`auto`. Host commands with bracket alternatives also expose their subcommands.
Relative paths such as `./src/` and
`../` complete from the current session's working directory. `@` file indexing
is not implemented.

The completion panel is an overlay above the composer. Showing or hiding it does
not change the editor height or move the input line.

## Session and model pickers

| Key | Action |
|---|---|
| `Up`, `Down`, `Ctrl+P`, `Ctrl+N` | Move the selection. |
| `n` (session picker, navigation mode) | Create a new session. |
| `f` (session picker, navigation mode) | Fork the selected session and open the child. |
| `a` (session picker, navigation mode) | Archive the selected session, or unarchive an archived row. |
| `p` (session picker, navigation mode) | Pin or unpin the selected session. |
| `Ctrl+A` (session picker, navigation mode) | Show or hide archived sessions. |
| `/` or any printable character | Enter incremental search. |
| Printable characters in search | Refine the filter across titles and workspace metadata. |
| `Enter` | Select the highlighted session, model, or group. |
| `Ctrl+U` | Clear the search query. |
| `Ctrl+W` | Delete the previous search word. |
| `Backspace` | Edit the search query. |
| `Mouse wheel` | Move the picker selection. |
| `Esc` | Close the picker from navigation or search mode. |

`Esc` closes the whole picker; it does not just leave search mode. Use `Ctrl+U`
or `Backspace` to clear the filter while keeping the picker open.

Search tokens match titles, working directories, descriptions, and the
underlying picker values (for the model picker, provider/model labels). A single
ASCII letter is matched at word starts to keep one-character queries useful.

Press `n` in navigation mode to create a session. `Enter` opens the highlighted
session. Once search mode is active, `n` is an ordinary search character.

## Subagent picker

`/subagent list` opens the lineage under the current session. `Enter` opens the
selected child's read-only history. Control keys act on the selected row only
when the Host reports them as available; the picker footer shows `c continue`
and `x stop` when at least one row supports them.

| Key | Action |
|---|---|
| `Up`, `Down`, `Ctrl+P`, `Ctrl+N` | Move the selection. |
| `Enter` | Open the selected subagent history. |
| `c` | Open the follow-up editor for a continuable child with a live parent. |
| `x` | Ask to stop the selected running subagent. |

While viewing a subagent's read-only history, go back without typing a command:

| Key | Action |
|---|---|
| `Backspace` | Return to the parent when the composer is empty. |
| `Alt+Left` | Return to the parent from any editor state. |
| `Esc` | Return to the parent when the subagent is idle; while it is running, keep `Esc` `Esc` for interrupt. |

The same actions are available as `/parent` (alias `/subagent parent`).
| `y` (confirmation) | Confirm the stop request. |
| `n`, `Enter`, `Esc` (confirmation) | Cancel the stop request. |
| `/` or any printable character | Enter incremental search; `c` and `x` are ordinary search characters there. |
| `Esc` | Close the picker. |

The picker marks a continuable child whose direct parent is not live with
`parent offline`; `c` then reports that the parent session must be opened first.
One-shot children never offer continuation. The confirmation text explains that
a one-shot or external execution stops permanently.

## Approvals

| Key | Action |
|---|---|
| `y`, `Y` | Allow once. |
| `n`, `N` | Reject. |
| `Enter`, `d`, `D`, `e`, `E` | Open the full request text, command, and raw arguments in a read-only details view. |
| `Esc` | Detach this terminal from the request; another client or timeout may answer it. |

`Enter` does not allow; it opens details so the high-impact action requires an
explicit `y`.

### Approval details

The details view is read-only and scrolls independently of the approval panel.

| Key | Action |
|---|---|
| `Up`, `Down`, `Ctrl+P`, `Ctrl+N`, `Mouse wheel` | Scroll one line. |
| `PgUp`, `PgDn`, `Ctrl+U`, `Ctrl+D` | Scroll one page. |
| `Home`, `End`, `g`, `G` | Jump to the top or bottom. |
| `Esc`, `q`, `Q` | Close details and return to the approval panel. |

## Questions

| Key | Action |
|---|---|
| `Up`, `Down`, `Ctrl+P`, `Ctrl+N` | Move between options. |
| `Space` | Toggle or select the highlighted option. |
| `Enter` | Select and advance; for a free-text question, submit the focused input. |
| `1`–`9` | Select an option by number. |
| `c` | Enter custom text for the current question. |
| `s` | Skip the entire batch and return `skipped` immediately. |
| `Esc` | Dismiss the TUI panel; the Host may hand the question to another client or its timeout. |

Questions without options open with a focused input immediately. For questions
with options, `c` opens custom text; `Enter` submits it and returns to the option
list, while `Esc` cancels the custom text. On a free-text question, `Esc`
dismisses the panel.

## Information panels

| Key | Action |
|---|---|
| `Esc`, `Enter`, `q` | Close the help or status panel. |

## Preview panes

| Key | Action |
|---|---|
| `PgUp` | Scroll back one page. |
| `PgDn` | Scroll forward one page. |
| `End` | Jump to the newest output. |
| `Ctrl+C`, `q`, `Q` | Close the preview pane. |

Managed Herdr preview panes stay open by default. Set
`DSH_ATTACH_PREVIEW_EXIT_AFTER` to a positive number of idle seconds to make
them auto-close.

## Queue manager

`/queue` with no text opens the pending-message manager. It lists messages from
any attached client, including this client's optimistic queued prompts once the
Host has accepted them.

| Key | Action |
|---|---|
| `↑`/`↓`, `Ctrl+P`/`Ctrl+N` | Move in the queue. |
| `Enter` | Open the full message, delivery target, and item id. |
| `e` | Edit the selected message in place. |
| `s` | Send a next-turn message into the running turn as steering. |
| `d` twice | Remove the selected pending message. |
| `r` | Refresh from the current snapshot. |
| `Esc` | Close the queue manager. |

The detail view scrolls with the usual page keys; `Esc`/`q` returns to the
queue manager. A message already in the next-step lane is steering already and
cannot be sent again.

## Background jobs

`/job list` opens the session's background-job picker. Running jobs sort first;
`Enter` opens the job's live, read-only output and `r` refreshes the roster.
Press `k` twice within three seconds to stop the selected job. The direct
forms are `/job output <job-id>` and `/job kill <job-id>` (the older
`/job-output` and `/job-kill` remain aliases).

| Key | Action |
|---|---|
| `↑`/`↓`, `Ctrl+P`/`Ctrl+N` | Move in the job picker. |
| `Enter` | Open the selected job's output. |
| `k` twice | Stop the selected running job. |
| `r` | Refresh the job roster. |
| `Esc` | Close the job picker. |

The output panel shows the job's command/label above its read-only output and
keeps following new output at the bottom. `PgUp`/`PgDn`, arrows, `Home`/`End`,
and `g`/`G` scroll; `Enter` or `d` opens the full job details (including untruncated
command, id, owner, timing and progress); `k` twice stops the job. `Esc` or `q`
returns to the job list when the panel was opened from `/job list`, or to the
composer when it was opened directly with `/job output`. The panel reads the
non-consuming observer cursor, so it never steals output from the model's
`job_output`.

## Slash commands

### Local commands

| Command | Description |
|---|---|
| `/help` | Show the built-in help. |
| `/session [list|new [cwd] [--preset <id>]|resume [id]|rename <title>|fork [id]|archive [id] [--stop]|unarchive <id>|pin [id]|unpin [id]|presets|preset [id]|delete [id]]` | Session picker, creation (with an optional Agent preset), resume, rename, fork, archive/unarchive, pin/unpin, preset roster/selection, or an explicit "deletion is unavailable" notice. Aliases: `/sessions`, `/new`, `/resume`, `/rename`. |
| `/reconnect` | Force a fresh Host connection and reopen the current session. |
| `/subagent [list|continue [id] [text]|interrupt [id]|stop [id]|cancel [id]|preview [count]|parent|peek]` | Subagent picker, follow-up delivery, confirmed stop, Herdr preview, parent navigation, or peek toggle. Aliases: `/subagents`, `/subagents-preview`, `/peek`. |
| `/parent` | Return to the parent session from a subagent history view. |
| `/image [paste|list|clear]` | Paste a clipboard image, list attached images, or clear them. Aliases: `/paste-image`, `/images`. |
| `/job [list|output <id>|kill <id>]` | List jobs, open live output, or stop a job. Aliases: `/jobs`, `/job-output`, `/job-kill`. |
| `/skill [list|show <name>|run <name>]` | List user-invocable skills, show a skill's instructions, or invoke it as a prompt. |
| `/todo` | Show the current model todo list with pending / in-progress / completed state. Alias: `/todos`. |
| `/goal [status|create <objective>|edit [objective]|pause|resume|complete|clear]` | Show or change the session goal. `complete` and `clear` require an explicit `y` confirmation. |
| `/plan [status|enter [message]|exit|approve]` | Enter, leave or inspect plan mode. `approve` answers an open plan-review question; otherwise use the plan-review question panel. |
| `/cancel` | Cancel the running turn (same as pressing `Esc` twice). In a subagent history view, ask before interrupting that subagent. |
| `/steer <text>` | Interrupt the turn and insert a steering message. |
| `/queue [text]` | Queue a message, or open the pending-message manager when no text is given. |
| `/find [text]` | Jump to the first loaded transcript match, or open an incremental transcript search when no text is given. |
| `/history` | Load the next older page of session history. Alias: `/earlier`. |
| `/model [provider model]` | Open the model picker, or switch directly. |
| `/permission [mode]` | Open the sandbox-preset picker, or apply `read-only`, `workspace-write`, `danger-full-access`, or `auto` directly. |
| `/detail [compact|standard|verbose]` | Set the single transcript detail level; no argument cycles. |
| `/btw <question>` | Ask a side question in an overlay without interrupting the turn. Bare `/btw` reopens the latest answer. |
| `/status` | Show session, model, preset, sandbox, context, token, queued-message count, todo, goal, host, theme, and socket details. |
| `/quit`, `/exit` | Exit the client without stopping Host work. |

The grouped commands complete their own subcommands: `/session resume`,
`/session fork`, `/session archive`, `/session unarchive`, `/session pin`, and
`/session unpin` complete session titles/IDs; `/session preset` and
`/session new --preset` complete Host Agent-preset ids; `/job output` and
`/job kill` complete job IDs; and `/subagent preview` completes the count.
`/skill show` and `/skill run` complete skill names; user-invocable skill names
also appear as top-level `/` commands after the local and Host commands. Legacy
hyphenated commands remain working for compatibility but are no longer listed in
completion.

### Host commands

Commands registered by the Host through `ctx.commands` are merged into the
command list after the local commands. An example is `/compact`. They execute
inside the Host and do not become model prompts. If the Host does
not recognize a command, or predates the command routes, the line is sent to
the model as a normal prompt.

Host command execution and subagent history require Host plugin 0.10.0 or
later; pending approvals and questions are replayed when a terminal attaches
late on Host plugin 0.8.0 or later. After installing or upgrading the plugin,
restart DeepSeek Harness so the new bridge is mounted.
