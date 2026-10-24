# Keys and commands

Local command names are case-insensitive. Local commands are handled by the
TUI; other slash commands are offered to the Host command registry before
falling back to a normal prompt.

## Global keys

| Key | Action |
|---|---|
| `Ctrl+C` | Quit immediately when idle with no panel open. While a turn is running or a panel is open, press twice within two seconds. Running Host work is not stopped; `/quit` always exits immediately. |
| `Esc` `Esc` | Interrupt the running turn (two presses within 750 ms). The first press shows `esc again to interrupt`. |
| `Ctrl+T` | Expand or collapse reasoning blocks. |
| `Ctrl+O` | Expand or collapse individual tool arguments and output. |
| `Ctrl+G` | Expand all step groups; by default running groups expand automatically. |
| `Ctrl+L` | Return to the newest message and resume auto-follow. |
| `PgUp` | Scroll the transcript up one page. |
| `Shift+PgUp`, `Alt+V`, `Ctrl+Alt+B` | Alternative scroll-up bindings. |
| `PgDn` | Scroll the transcript down one page. |
| `Shift+PgDn`, `Ctrl+V`, `Ctrl+Alt+F` | Alternative scroll-down bindings. |
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
the argument. `/resume` completes session titles and IDs; `/model` completes
`provider/model` pairs; relative paths such as `./src/` and `../` complete from
the current session's working directory. `@` file indexing is not implemented.

The completion panel is an overlay above the composer. Showing or hiding it does
not change the editor height or move the input line.

## Session and model pickers

| Key | Action |
|---|---|
| `Up`, `Down`, `Ctrl+P`, `Ctrl+N` | Move the selection. |
| `n` (session picker, navigation mode) | Create a new session. |
| `/` or any printable character | Enter incremental search. |
| Printable characters in search | Refine the filter across titles and workspace metadata. |
| `Enter` | Select the highlighted session, model, or group. |
| `Ctrl+U` | Clear the search query. |
| `Ctrl+W` | Delete the previous search word. |
| `Backspace` | Edit the search query. |
| `Esc` | Close the picker from navigation or search mode. |

`Esc` closes the whole picker; it does not just leave search mode. Use `Ctrl+U`
or `Backspace` to clear the filter while keeping the picker open.

Search tokens match titles, working directories, descriptions, and the
underlying picker values (for the model picker, provider/model labels). A single
ASCII letter is matched at word starts to keep one-character queries useful.

Press `n` in navigation mode to create a session. `Enter` opens the highlighted
session. Once search mode is active, `n` is an ordinary search character.

## Approvals

| Key | Action |
|---|---|
| `y`, `Y`, `Enter` | Allow once. |
| `n`, `N`, `Esc` | Reject. |
| `d`, `D`, `e`, `E` | Open the full request text, command, and raw arguments in a read-only details view. |

### Approval details

The details view is read-only and scrolls independently of the approval panel.

| Key | Action |
|---|---|
| `Up`, `Down`, `Ctrl+P`, `Ctrl+N` | Scroll one line. |
| `PgUp`, `PgDn`, `Ctrl+U`, `Ctrl+D` | Scroll one page. |
| `Home`, `End`, `g`, `G` | Jump to the top or bottom. |
| `Esc`, `q`, `Q` | Close details and return to the approval panel. |

## Questions

| Key | Action |
|---|---|
| `Up`, `Down`, `Ctrl+P`, `Ctrl+N` | Move between options. |
| `Space` | Toggle or select the highlighted option. |
| `Enter` | Select and advance; with no options, enter custom text. |
| `1`–`9` | Select an option by number. |
| `c` | Enter custom text for the current question. |
| `s` | Skip the entire batch and return `skipped` immediately. |
| `Esc` | Dismiss the TUI panel; the Host may hand the question to another client or its timeout. |

In custom-text mode, `Enter` submits the text and returns to the option list;
`Esc` returns without submitting.

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
| `s` | Send a next-turn message into the running turn as steering. |
| `d` twice | Remove the selected pending message. |
| `r` | Refresh from the current snapshot. |
| `Esc` | Close the queue manager. |

The detail view scrolls with the usual page keys; `Esc`/`q` returns to the
queue manager. A message already in the next-step lane is steering already and
cannot be sent again.

## Background jobs

`/jobs` opens the session's background-job picker. Running jobs sort first;
`Enter` opens the job's live, read-only output and `r` refreshes the roster.
Press `k` twice within three seconds to stop the selected job. The direct
forms are `/job-output <job-id>` and `/job-kill <job-id>`.

| Key | Action |
|---|---|
| `↑`/`↓`, `Ctrl+P`/`Ctrl+N` | Move in the job picker. |
| `Enter` | Open the selected job's output. |
| `k` twice | Stop the selected running job. |
| `r` | Refresh the job roster. |
| `Esc` | Close the job picker. |

The output panel shows the job's command/label above its read-only output and
keeps following new output at the bottom. `PgUp`/`PgDn`, arrows, `Home`/`End`,
and `g`/`G` scroll; `k` twice stops the job. `Esc` or `q` returns to the job
list when the panel was opened from `/jobs`, or to the composer when it was
opened directly with `/job-output`. The panel reads the non-consuming observer
cursor, so it never steals output from the model's `job_output`.

## Slash commands

### Local commands

| Command | Description |
|---|---|
| `/help` | Show the built-in help. |
| `/sessions` | Open the session picker. |
| `/reconnect` | Force a fresh Host connection and reopen the current session. |
| `/subagents` | List subagents under the current session, active first. `/agents` is an alias. |
| `/subagents-preview [count]` | Open running subagents in managed Herdr plugin panes (1–2). `/agents-preview` is an alias. |
| `/peek` | Toggle the bounded subagent peek. |
| `/jobs` | List background jobs; `Enter` opens output, `k` twice stops, `r` refreshes. |
| `/job-output <id>` | Open a background job's live read-only output. |
| `/job-kill <id>` | Request cancellation of a background job. |
| `/parent` | Open the direct parent of a subagent history. |
| `/new [cwd]` | Create a session, optionally in `cwd`. |
| `/resume [id]` | Open the picker, or open the given session directly. |
| `/rename <title>` | Rename the current session. |
| `/cancel` | Cancel the running turn (same as pressing `Esc` twice). |
| `/steer <text>` | Interrupt the turn and insert a steering message. |
| `/queue [text]` | Queue a message, or open the pending-message manager when no text is given. |
| `/model [provider model]` | Open the model picker, or switch directly. |
| `/status` | Show session, model, preset, sandbox, context, token, queued-message count, todo, goal, host, theme, and socket details. |
| `/quit`, `/exit` | Exit the client without stopping Host work. |

### Host commands

Commands registered by the Host through `ctx.commands` are merged into the
command list after the local commands. Examples include `/compact` and `/goal`.
They execute inside the Host and do not become model prompts. If the Host does
not recognize a command, or predates the command routes, the line is sent to
the model as a normal prompt.

Host command execution and subagent history require Host plugin 0.10.0 or
later; pending approvals and questions are replayed when a terminal attaches
late on Host plugin 0.8.0 or later. After installing or upgrading the plugin,
restart DeepSeek Harness so the new bridge is mounted.
