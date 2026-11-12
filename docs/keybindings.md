# Keys and commands

Local command names are case-insensitive. Other slash commands go to the Host
command registry, then fall back to a prompt.

## Global

| Key | Action |
|---|---|
| `Ctrl+C` | Quit immediately when idle/no panel; twice while active. `/quit` always exits. |
| `Esc` `Esc` | Interrupt the running turn (750 ms). In subagent history, asks to stop the child. |
| `Ctrl+G` | Cycle detail: `compact` → `standard` → `verbose`. |
| `/detail [level]` | Set detail directly; bare cycles. |
| `Ctrl+L` | Jump to newest and resume follow. |
| `Ctrl+R` | Load one older history page, anchored. |
| `PgUp`, `Shift+PgUp`, `Alt+V`, `Ctrl+Alt+B` | Scroll up. |
| `PgDn`, `Shift+PgDn`, `Ctrl+Alt+F` | Scroll down. |
| `Ctrl+Home` / `Ctrl+End` | Top / bottom of loaded history. |
| Mouse wheel | Scroll. |

Page/jump keys apply only without a modal; `Esc` closes panels/pickers/completion
first.

## Composer

| Key | Action |
|---|---|
| `Enter` | Send; queues while a turn runs. |
| `Ctrl+V` / `Cmd+V` | Paste image or text. |
| `Ctrl+Shift+V` | Paste image, with text fallback. |
| `Shift+Enter`, `Ctrl+J` | Newline. |
| `Up`/`Ctrl+P`, `Down`/`Ctrl+N` | Move / previous / next prompt. |
| `Left`/`Ctrl+B`, `Right`/`Ctrl+F` | Character left/right. |
| `Alt+B`/`Ctrl+Left`/`Alt+Left`, `Alt+F`/`Ctrl+Right`/`Alt+Right` | Word left/right. |
| `Home`/`Ctrl+A`, `End`/`Ctrl+E` | Line start/end. |
| `Ctrl+K`, `Ctrl+U` | Kill to end/start. |
| `Ctrl+W`, `Alt+Backspace` | Delete previous word. |
| `Alt+D`, `Alt+Delete` | Delete next word. |
| `Ctrl+D`, `Delete`, `Backspace` | Delete character. |
| `Ctrl+Y`, `Alt+Y` | Yank / cycle kill ring. |
| `Ctrl+-` | Undo. |
| `Ctrl+]`, `Ctrl+Alt+]` | Jump to character forward/backward. |

Prompt history is per run, max 100. Arrow past the newest entry restores the
draft.

## Completion

| Key | Action |
|---|---|
| `/` at line start | Open commands. |
| `Tab` | Insert completion without executing. |
| `Enter` | Insert and execute a slash command; paths insert without submit. |
| `Ctrl+N`/`Ctrl+P`/`Up`/`Down` | Move selection. |

Space or `Tab` after a command opens argument suggestions. Completion covers
`/session` subcommands, presets, job/subagent IDs, skills, `/model`,
`/permission`, and relative paths. `@` file indexing is not implemented.
The panel floats above the composer without changing its height.

## Session and model pickers

| Key | Action |
|---|---|
| `Up`/`Down`/`Ctrl+P`/`Ctrl+N` | Move. |
| `n` | New session. |
| `f` | Fork selected session. |
| `a` | Archive/unarchive. |
| `p` | Pin/unpin. |
| `Ctrl+A` | Show/hide archived. |
| `/` or printable | Search. |
| `Ctrl+U`, `Ctrl+W`, `Backspace` | Clear/delete search. |
| `Enter` | Select. |
| `Esc` | Close. |

`Esc` closes the picker, not just search. `n` is a search character once search
is active.

## Subagent picker

| Key | Action |
|---|---|
| `Up`/`Down`/`Ctrl+P`/`Ctrl+N` | Move. |
| `Enter` | Open read-only history. |
| `c` | Continue a continuable child with a live parent. |
| `x` | Ask to stop a running child. |
| `y` | Confirm stop. |
| `n`/`Enter`/`Esc` | Cancel stop. |
| `Esc` | Close picker. |

In a subagent history:

| Key | Action |
|---|---|
| `Backspace` (empty composer) | Parent. |
| `Alt+Left` | Parent from any editor state. |
| `Esc` | Parent when idle; while running, use `Esc` `Esc` to interrupt. |

`/parent` and `/subagent parent` do the same. One-shot/external children cannot
continue; a missing live parent is marked `parent offline`.

## Approvals

| Key | Action |
|---|---|
| `y`/`Y` | Allow once. |
| `n`/`N` | Reject. |
| `Enter`/`d`/`D`/`e`/`E` | Read-only details. |
| `Esc` | Detach this terminal. |

Details: arrows/`Ctrl+P`/`Ctrl+N`/wheel scroll; `PgUp`/`PgDn`/`Ctrl+U`/`Ctrl+D`
page; `Home`/`End`/`g`/`G` jump; `Esc`/`q` close.

## Questions

| Key | Action |
|---|---|
| `Up`/`Down`/`Ctrl+P`/`Ctrl+N` | Move options. |
| `Space` | Toggle/select. |
| `Enter` | Select/advance/submit text. |
| `1`–`9` | Select by number. |
| `c` | Custom text. |
| `s` | Skip batch. |
| `Esc` | Dismiss; another client/timeout may answer. |

## Panels

| Panel | Keys |
|---|---|
| Info | `Esc`/`Enter`/`q` close. |
| Preview | `PgUp`/`PgDn`, `End`, `Ctrl+C`/`q` close. |
| Queue | `↑`/`↓`, `Enter` details, `e` edit, `s` steer-now, `d` twice remove, `r` refresh, `Esc` close. |
| Jobs | `↑`/`↓`, `Enter` output, `k` twice stop, `r` refresh, `Esc` close. Job output: page/arrow/`Home`/`End`/`g`/`G`; `Enter`/`d` details; `Esc`/`q` back. |

Queue detail scrolls with page keys; `Esc`/`q` returns. Auto-close Herdr previews
with `DSH_ATTACH_PREVIEW_EXIT_AFTER`; default stays open.

## Local commands

| Command | Description |
|---|---|
| `/help` | Help. |
| `/session [list|new [cwd] [--preset <id>]|resume [id]|rename <title>|fork [id]|archive [id] [--stop]|unarchive <id>|pin [id]|unpin [id]|presets|preset [id]|delete [id]]` | Session lifecycle. Aliases: `/sessions`, `/new`, `/resume`, `/rename`. |
| `/reconnect` | Reconnect and reopen. |
| `/subagent [list|continue [id] [text]|interrupt [id]|stop [id]|cancel [id]|preview [count]|parent|peek]` | Subagent control. Aliases: `/subagents`, `/subagents-preview`, `/peek`. |
| `/parent` | Parent session. |
| `/image [paste|list|clear]` | Clipboard images. Aliases: `/paste-image`, `/images`. |
| `/job [list|output <id>|kill <id>]` | Jobs. Aliases: `/jobs`, `/job-output`, `/job-kill`. |
| `/skill [list|show <name>|run <name>]` | Skills. |
| `/todo` | Todo list. Alias: `/todos`. |
| `/goal [status|create <objective>|edit [objective]|pause|resume|complete|clear]` | Goal; complete/clear ask `y`. |
| `/plan [status|enter [message]|exit|approve]` | Plan mode / plan review. |
| `/cancel` | Cancel turn; confirms subagent interrupt. |
| `/steer <text>` | Interrupt and steer. |
| `/queue [text]` | Queue or open manager. |
| `/find [text]` | Transcript search. |
| `/history` | Older page. Alias: `/earlier`. |
| `/model [provider model]` | Picker or direct switch. |
| `/permission [mode]` | Picker or `read-only`/`workspace-write`/`danger-full-access`/`auto`. |
| `/detail [compact|standard|verbose]` | Detail level. |
| `/btw <question>` | Side question; `f` starts a background fork with tools. |
| `/approvals [on|off|add <json>|remove <id>|suggest]` | Inspect or edit auto-approval; advanced settings belong in `auto-approve.json`. |
| `/status` | Session/status details. |
| `/quit`, `/exit` | Exit without stopping Host work. |

Legacy hyphenated commands still work but are not listed in completion.

## Host commands

Host `ctx.commands` entries are merged after local commands and execute inside
the Host (for example `/compact`). Unknown commands become normal prompts. Host
commands/subagent history require plugin 0.10.0+; pending interaction replay
requires 0.8.0+. Reload DSH after plugin upgrades.


## Side-question card

| Key | Action |
|---|---|
| `Space`, `Enter` | Dismiss the card; a pending answer keeps running. |
| `Esc` | Cancel a pending answer, or dismiss a completed card. |
| `Up` / `Down` | Scroll the answer. |
| `[` / `]` | Move between earlier side questions. |
| `c` | Copy the raw Markdown answer. |
| `x` | Clear earlier side questions, keeping the current card. |
| `f` | Start a background fork with full tools. |
