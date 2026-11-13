# Usage

## Layout

```text
header      connection · session · agents · cwd
transcript  messages, answers, reasoning, tools
peek        running subagents (max 2)
queue       pending messages
activity    turn/step, queue, goals, jobs
composer    prompt + floating completion
footer      keys, tokens/context, permission
```

## Turn folding

Each turn groups reasoning and tools. Running work expands with live labels such
as `Analyzing the request`, `Preparing`, or `Running commands · npm test`.
Finished work collapses:

```text
▸ ✓ Completed at 23:44:23 · 2m 13s · 42 tool calls
```

Detail levels:

| Level | Behavior |
|---|---|
| `compact` | Fold running and completed turns. |
| `standard` | Open running turn; fold completed turns. |
| `verbose` | Expand turn work, tools, reasoning. |

`Ctrl+G` cycles; `/detail compact|standard|verbose` sets. Assistant replies stay
visible. `/status` and the activity line show timing and activity.

## Sessions

No arguments opens the picker. Rows show title/workspace, cwd, subagent count,
age. Current session `★`, running `●`, pinned `◆`. Search by typing or `/`.

Picker keys: `n` new, `f` fork, `a` archive/unarchive, `p` pin/unpin,
`Ctrl+A` archived, `Enter` open, `Esc` close, `Ctrl+U`/`Ctrl+W`/`Backspace`
search.

```text
dsh-attach -s <id> / --reattach <id>
/session new [cwd] [--preset <id>]
/session rename <title>
/session fork [id]
/session archive [id] [--stop]
/session unarchive <id>
/session pin|unpin [id]
/session presets | /session preset [id]
```

`[id]` defaults to the open session. Archive refuses running work unless
`--stop`. DSH has no Session deletion; `/session delete` reports that.

Agent presets apply to new sessions. `/session presets` shows the roster;
`/session preset <id>` picks; `/session new --preset <id>` overrides once.

## Prompts and queue

`Enter` sends and follows the live edge. While a turn runs, prompts queue.
Activity shows `queued`; pending messages appear above the composer.

```text
/steer <text>   interrupt and steer
/queue <text>   queue
/queue          manage pending messages
```

Queue manager: `Enter` details, `e` edit, `s` steer now, `d` twice remove,
`r` refresh, `Esc` close.

`Esc` twice (750 ms) or `/cancel` stops the turn. First `Esc` shows the hint.

Images: `Ctrl+V`/`Cmd+V`, `Ctrl+Shift+V`, or `/image paste`. `Ctrl+V` falls back
to text if no image. `/image list`, `/image clear`. Max 8 images. No file upload
or `@` indexing.

## History and search

Initial snapshot: 300 messages (Host `historyMessages`). Activity shows
`earlier history not loaded` when more exist.

- `Ctrl+R` or `/history` loads one older page anchored to the viewport.
- `Ctrl+L`, `Ctrl+End`, or sending returns to the live edge.
- `PgUp`/`PgDn` and alternatives scroll; `Ctrl+Home`/`Ctrl+End` jump.
- `/find <text>` jumps; bare `/find` opens search.
- Following keeps 5,000 rows; 10,000 hard cap; paging ceiling 25,000.

Prompt history is per run, max 100. Drafts survive history browsing.

## `/btw`

```text
/btw <question>
```

Answers from the conversation the main model can see: system/project context,
messages, and tool results, excluding the reply still being written. It does
not queue, interrupt, or enter the conversation; there are no tools. The
answer streams into the overlay and stays out of session history. If a model
emits tool-call markup anyway, it is stripped and the card notes that nothing
was executed.

A later side question replays the last 20 completed asides, so follow-ups work;
`x` clears them. Bare `/btw` reopens the latest. `Esc` cancels a pending
answer, `Space`/`Enter` dismiss the card, `c` copies the raw Markdown, `[`/`]`
navigates earlier asides, and `Up`/`Down` scroll.

`f` starts a background fork subagent with full tools while the main session
stays open; its report is announced in the transcript and the child appears in
`/subagent list`. Hosts without the fork-subagent route fall back to a Session
fork. One side question runs at a time.

## Goals and plans

```text
/goal                         status
/goal <objective>             create and arm
/goal edit [objective]        edit
/goal pause|resume            pause/resume
/goal complete|clear          confirm with y
```

`/plan` enters plan mode; `/plan <message>` enters and steers;
`/plan off|exit` leaves; `/plan status` shows state. Plan approval uses the
normal question panel.

## Todos and skills

`/todo` shows pending/in-progress/completed items; activity shows counts.

`/skill list`, `/skill show <name>`, `/skill run <name>`. User skills also
complete as `/name` unless shadowed.

## Approvals

| Key | Action |
|---|---|
| `y` | Allow once. |
| `n` | Reject. |
| `Enter`/`d`/`e` | Full details. |
| `Esc` | Detach; another client/timeout may answer. |

Details are scrollable; `Esc`/`q` returns. Routing modes (`tui`, `auto`, `web`,
`off`), grace periods, and optional whitelist + LLM auto-approval are in
[Configuration](configuration.md).

```text
/approvals             status
/approvals on|off      enable or disable
/approvals add <json>  append a rule
/approvals remove <id> remove a rule
/approvals suggest     propose a rule from the last approval
```

Edit `auto-approve.json` for mode, policy, full-access, and limits; it reloads
within 2 seconds.

`/approvals suggest` asks the model for a rule based on the last approval; it is
saved only after `y` confirmation. Late attach replays pending requests on
Host 0.8.0+.

## Questions

| Key | Action |
|---|---|
| `Up`/`Down`/`Ctrl+P`/`Ctrl+N` | Move. |
| `Space` | Toggle/select. |
| `Enter` | Select/advance/submit text. |
| `1`–`9` | Select by number. |
| `c` | Custom text. |
| `s` | Skip batch. |
| `Esc` | Detach from this client. |

Answers submit as one batch. `Esc` does not answer.

## Subagents

Header/activity show lineage counts, e.g. `agents 1/27`.

```text
/subagent list
/subagent continue <id> <message>
/subagent interrupt|stop|cancel [id]
/subagent parent
/subagent peek
```

Picker: `Enter` history, `c` continue, `x` stop. History is read-only; back with
`Backspace` (empty composer), `Alt+Left`, `Esc` when idle, or `/parent`.

Continuation needs a continuable child with a live direct parent. Interrupt
confirms with `y`; it acknowledges cancellation, not quiescence. One-shot or
external children stop permanently. No new subagent dispatch or parent approval
routing from the TUI.

## Jobs

`/job list` shows live jobs first. `Enter` opens live output, `r` refreshes,
`k` twice stops. Direct: `/job output <id>`, `/job kill <id>`. Output view:
page/arrow/`Home`/`End`/`g`/`G`; `Enter`/`d` full details; `Esc`/`q` back.
Viewing uses the observer cursor and does not consume model output.

Requires Host job routes and registry.

## Reattach and reconnect

Clean exit prints:

```text
Reattach with: dsh-attach --reattach <session-id>
```

Preserves profile, endpoint, theme; suppress with `DSH_ATTACH_NO_EXIT_HINT=1`.
Signal/crash exits do not print it.

After Host restart, the client retries and reopens the session; `/reconnect`
forces it. A durably interrupted last turn gets one continuation prompt with a
stable request id. `DSH_ATTACH_AUTO_RESUME=0` disables it. Pending approvals or
questions from the old process may be lost.

## Multiple terminals

TUI-mode approvals/questions broadcast to all TUIs on the session; first answer
wins. The terminal follows one session at a time; other sessions keep running.

## Mouse and focus

Default is button-motion tracking (`1002`); `DSH_ATTACH_FULL_MOUSE=1` enables
all-motion (`1003`); `DSH_ATTACH_NO_MOUSE=1` disables mouse/focus reporting.
Focus loss hides the empty-composer cursor.
