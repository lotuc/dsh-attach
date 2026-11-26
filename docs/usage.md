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

## Command-line execution

`--exec` runs one prompt without a TUI. It creates a new Session by default,
prints the final assistant text to stdout, and exits with `0` on completion,
`1` on a failed turn or runtime error, `124` on timeout, `130` when interrupted,
or `2` on invalid arguments or prompt input.

```sh
dsh-attach --exec -p "fix the failing test"
dsh-attach --exec -s <session-id> -p "continue"
dsh-attach --exec -f prompt.md -o answer.md
printf 'summarize this repository' | dsh-attach --exec
```

- `--session <id>` reuses an idle Session; `--new` is implied otherwise.
- `--cwd` applies only to a new Session.
- `--exec-timeout <seconds>` cancels a stalled turn; default 1800, `0` waits forever.
- `-p/--prompt`, `-f/--prompt-file`, and stdin are prompt sources; `-p` and `-f`
  are mutually exclusive, and an empty prompt or file is rejected.
- The client prints `dsh-attach: session <id>` to stderr as soon as the Session
  opens. A timeout, interrupt, connection error, or failed turn therefore leaves
  a resumable id: use `-s <id>` to continue it.
- The runner is non-interactive. By default approvals are rejected and
  questions are cancelled, then reported in `interactions` and on stderr.
- `--approvals=host` delegates approvals/questions to the native DSH Web
  answerer instead; it requires that UI to be open and a Host approval mode
  other than `first-win`.
- `--approve` allows every approval for that exec run. It is a broad,
  dangerous grant; use it only for a task and repository you trust.
- `--approval-rules <file|@default>` applies scoped rules for that exec run.
  The file uses the same TOML/JSONC shape as the TUI's `auto-approve.toml`;
  `@default` reads the TUI policy (`DSH_ATTACH_AUTO_APPROVE`, or
  `$DSH_HOME/dsh-attach/auto-approve.toml`).

### Sandbox, permission, model, preset, and title

`--allow-dir <path>` (repeatable, `~` expanded) registers a writable root for
the Session after it opens and before the prompt. The Host must advertise
`sandbox.roots`; if it does not, rejects the directory (`invalid-root`), or
leaves the grant unregistered, exec fails before sending the prompt. Grants are
runtime-only and disappear when the Session detaches.

`--permission <read-only|workspace-write|danger-full-access|auto>` applies
`/permission <value>` after opening the Session and before the prompt. A Host
without the command registry, or a command the Host does not run, fails exec
with a clear error instead of silently running under the old preset.
`danger-full-access` is a broad grant; pass it only for a task and repository
you trust.

`--model <provider/model>` splits at the first slash, so model ids that contain
a slash keep their full name, and calls `session.selectModel` before the prompt.

`--preset <id>` creates a new Session with that agent preset. It is rejected
together with `-s/--session`; omit `--new` and the preset applies to the new
Session created by exec.

`--title <text>` renames the Session after it opens and before the prompt.

### Prompt and output files

```sh
dsh-attach --exec -f prompts/nightly.md -o out/answer.md
```

- `-f/--prompt-file <path>` reads UTF-8 prompt text; a file that is empty after
  trimming is rejected.
- `-o/--output <path>` writes the final assistant text after the run when it is
  non-empty, creating parent directories. Stdout and `--json` output are
  unchanged.

### Machine-readable output

```sh
dsh-attach --exec --json -p "fix the failing test"
```

```json
{
  "ok": true,
  "sessionId": "session-...",
  "turn": 1,
  "text": "done",
  "reason": "complete",
  "failure": null,
  "usage": { "inputTokens": 1436, "outputTokens": 2 },
  "interactions": [],
  "error": null
}
```

A failed or interrupted run keeps the same shape and includes
`"sessionId": "<id or null>"` in the error object, for example
`{"ok":false,"sessionId":"session-...","error":{"code":"attach/exec-timeout","message":"..."}}`.

`--jsonl` streams newline-delimited progress events instead of one result. It is
incompatible with `--json`.

```json
{"type":"session.started","sessionId":"session-...","cwd":"/work"}
{"type":"tool.call","sessionId":"session-...","callId":"call-1","name":"bash"}
{"type":"interaction","sessionId":"session-...","kind":"approval","requestId":"req-1","tool":"bash","callId":"call-1","reason":"needs write access","outcome":"rejected","decision":"non-interactive exec mode"}
{"type":"turn.end","ok":true,"sessionId":"session-...","turn":1,"text":"done","reason":"complete","failure":null,"usage":{},"interactions":[],"error":null}
```

`turn.end` is the final event when the turn finishes (successfully or not). If
the runner throws (timeout, interrupt, closed connection), the final event is
`{"type":"error","ok":false,"sessionId":"<id or null>","error":{"code":"...","message":"..."}}`.
Exit codes are the same as the non-streaming modes.

### Approval rules for exec

```toml
enabled = true
mode = "rules"

[[rules]]
id = "tests"
tool = "bash"
command_prefix = ["npm", "test"]

[[rules]]
id = "source"
tool = "write"
path_prefix = "src/"
```

```sh
dsh-attach --exec --json --approval-rules ./approval.toml -p "run the tests"
dsh-attach --exec --approval-rules @default -p "run the tests"
```

- A matching rule allows the call; a blocked or unmatched call follows
  `--approvals` (`deny` by default, or `host` to delegate to DSH Web).
- `mode = "review"` sends unmatched requests through the Host review route
  using `policy`; the Host's `displayReason` is forwarded to the reviewer.
- `enabled = false` makes the file invalid for an exec run.
- `--approve` overrides rules for the whole run.
- The file is explicit, so omitting `enabled` enables it; this differs from
  the TUI's default-off auto-approval config.
- `@default` resolves to `DSH_ATTACH_AUTO_APPROVE` when it is set and not
  `off`/`0`, otherwise to `$DSH_HOME/dsh-attach/auto-approve.toml`.
- Rules are not a security sandbox; the DSH permission/sandbox still applies.

## Remote SSH

`--ssh <target>` attaches to a Host on another machine without opening a TCP
listener there. The local client spawns:

```text
ssh -T -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o ConnectTimeout=10 \
    [BatchMode] <target> -- dsh-attach --stdio-proxy [--profile ...] [--endpoint ...]
```

`--stdio-proxy` runs on the remote host, discovers that host's
`$DSH_HOME/dsh-attach/endpoint.json`, dials its Unix socket or Windows named
pipe, and pipes NDJSON frames over the SSH stdin/stdout stream. It intercepts
only the opening `hello` to replace the local client's empty token with the
descriptor token, so the token never leaves the remote machine and no Host
protocol change is involved.

```sh
dsh-attach --ssh user@host
dsh-attach --ssh user@host -s <session-id>
dsh-attach --ssh user@host --exec --jsonl -p "run the tests"
dsh-attach --ssh user@host --list --json
dsh-attach --ssh user@host --remote-bin ~/.local/bin/dsh-attach
dsh-attach --ssh user@host --ssh-opt "-o" --ssh-opt "StrictHostKeyChecking=accept-new"
dsh-attach --remote win
dsh-attach --ssh win
```

- `--exec` and `--list` always add `BatchMode=yes`; key or agent auth must be
  configured because no password prompt can appear.
- The remote executable is probed as `dsh-attach` on `PATH`,
  `$HOME/.local/bin/dsh-attach`, then
  `$HOME/.dsh/profiles/*/node_modules/.bin/dsh-attach`. `--remote-bin` skips the
  probe; on a Windows remote pass the resolved `.cmd` path.
- `--cwd`, `--allow-dir`, `--endpoint`, and `--cache-root` are remote paths and
  are not expanded locally. `--cache-root @cwd` is rejected because the local
  cwd is meaningless; use `@session` or an explicit remote path. `-f`, `-o`,
  `--log`, and `--approval-rules` remain local files.
- `--ssh` cannot be combined with `--socket` or `--hot`; `--remote` cannot be
  combined with `--ssh`, `--socket`, `--hot`, or `--stdio-proxy`.
  `--remote-bin` and `--ssh-opt` require `--ssh` or `--remote`.
- The header shows `ssh:<target>` (or `ssh:<alias>` when using a remote alias).
  `/desktop` is disabled because it would focus the local desktop, and local
  `HERDR_*` variables are not forwarded to the remote Host.
- A Host restart on the remote side is handled by reconnecting with a fresh
  SSH proxy, which re-discovers the new PID, socket path, and rotated token.

### Remote aliases

Define a named profile once, then use it for every session, `--exec`, `--list`,
or reconnect:

```sh
dsh-attach remote add win --ssh user@localhost \
  --ssh-opt -p2233 \
  --remote-bin "C:/Users/me/AppData/Roaming/npm/dsh-attach.cmd" \
  --profile desktop --cache-root @session

dsh-attach --remote win --list --json
dsh-attach --remote win --exec --jsonl -p "run the tests"
dsh-attach --ssh win -s <session-id>   # transparent alias lookup
```

`$DSH_HOME/dsh-attach/remotes.toml` stores the aliases; set
`DSH_ATTACH_REMOTES` to use another path. `dsh-attach remote list [--json]`,
`remote show <name> [--json]`, and `remote remove <name>` inspect or edit the
file. `remote add` refuses an existing name unless `--force` is passed, and
rejects `--cache-root @cwd`.

- `--remote` is mutually exclusive with `--ssh`, `--socket`, `--hot`, and
  `--stdio-proxy`.
- CLI `--profile`, `--remote-bin`, `--endpoint`, and `--cache-root` override
  the alias fields; repeated `--ssh-opt` values are appended to its options.
- The header and clean-exit reattach hint stay concise by printing
  `ssh:<alias>` and `dsh-attach --remote <alias> --reattach <id>` instead of
  repeating the raw SSH flags.

## Session listing

`--list` prints `ID`, `AGE`, `STATE`, `CWD`, and `TITLE`; subagent Sessions are
hidden unless `--all` is used. `--list --json` prints one object with the same
filtering and newest-first order, but no truncation:

```sh
dsh-attach --list --json
dsh-attach --list --json --all
```

```json
{
  "items": [
    {
      "sessionId": "session-...",
      "title": "nightly",
      "cwd": "/work/project",
      "updatedAt": 1730000000000,
      "running": false,
      "blank": false,
      "parentSessionId": null,
      "origin": "user",
      "agentPreset": "minimal",
      "model": { "provider": "provider", "model": "model" }
    }
  ]
}
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

## Cache root

`dsh-attach --cache-root <path|@cwd|@session>` keeps language-tool caches out
of the home directory for every model shell call. It is off by default.

- `<path>`: use this directory as the cache root.
- `@cwd`: use `<launch directory>/.cache`.
- `@session`: use `<session workspace>/.cache`; changing sessions resolves
  against each session's own workspace.
- With `--ssh`, explicit paths are remote paths and are not expanded; `@cwd`
  is rejected. `@session` and explicit remote paths still work.

The Host derives `CLJ_CACHE`, `GITLIBS`, `GRADLE_USER_HOME`, `LEIN_HOME`,
`COURSIER_CACHE`, `PIP_CACHE_DIR`, `npm_config_cache`, `CARGO_HOME`,
`GOMODCACHE`, `GOCACHE`, and `MAVEN_ARGS` from the root. The cache root must
already be writable under the session sandbox, or model shell calls receive the
usual sandbox denial.

Clojure's Maven repository is configured by `deps.edn` `:mvn/local-repo` rather
than an environment variable; add it to `~/.clojure/deps.edn` or the project's
`deps.edn` when `--cache-root` should cover Clojure's Maven artifacts too.

Several terminals may follow the same session: the newest non-empty Herdr
environment and the newest non-null cache root are merged independently, so a
terminal that only forwards a cache root never erases another terminal's Herdr
facts, and one that only forwards Herdr facts never erases another terminal's
cache root. When `@session` cannot be resolved (the Host cannot read the session
workspace cwd without resuming it), the cache root is disabled and the client
reports it once. A superseded open is ignored for that report.

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
emits tool-call markup anyway, it is stripped; if the model tried to use a
tool, the card tells you to press `f` for a tool-enabled fork.

A later side question replays the last 20 completed asides, so follow-ups work;
`x` clears them. Bare `/btw` reopens the latest. `Esc` cancels a pending
answer, `Space`/`Enter` dismiss the card, `c` copies the raw Markdown, `[`/`]`
navigates earlier asides, `Up`/`Down` scroll, and `F` toggles full screen
for reading or selecting a long answer.

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

`/skills` opens a searchable picker. `Enter` runs a skill, or inserts
`/skill-name ` when the skill advertises an argument hint. `Tab` always inserts
the command so arguments can be typed.

`/skills list` prints the catalog; `/skills show <name>` shows instructions;
`/skills run <name> [args...]` invokes a skill explicitly. User skills also
complete as `/name` with a `skill` label and argument hint, unless shadowed.

## Links

`/links` collects HTTP(S) links from the loaded transcript. `Enter` copies the
selected URL to the system clipboard and `o` opens it with the platform browser.
This is the fallback for terminals that do not support OSC 8 hyperlinks.

## Rewind

`/rewind` opens a picker of loaded user messages. Selecting one replaces that
message and everything after it on the model-visible surface in the same
session. `/rewind <seq>` selects a sequence directly.

This is conversation-only: workspace files are unchanged, the durable event
log still contains the old events, and the client removes the rewound rows from
the loaded transcript. Cancel a running turn before rewinding.

## Desktop focus

`/desktop` raises DSH Desktop and selects the current session by id. The TUI
writes one request to a loopback bridge and opens `dsh://open`; the web client
half bundled with `dsh-attach` polls the bridge and calls the harness's
`uiWorkspace.openSession()`. The session id is never passed through the `dsh`
protocol. In `--ssh` mode `/desktop` is disabled: the remote session cannot
focus the local DSH Desktop.

The bridge listens on `127.0.0.1:39765`; requests expire after 30 seconds. The
web client half loads only in the Web/Desktop client, so restart DSH Desktop once
after installing this version. No Accessibility permission is required.

## Approvals

| Key | Action |
|---|---|
| `y` | Allow once. |
| `n` | Reject. |
| `s` | Allow this session: derive one narrow rule from this call and auto-allow matches. |
| `a` | Always allow: preview the same rule, append it to `auto-approve.toml`, then allow. |
| `r` | Reject now, then send a short note to steer or queue guidance for the model. |
| `w` | Under `workspace-write`, grant the target's parent directory as a writable root, then allow. |
| `Enter`/`d`/`e` | Full details. |
| `Esc` | Detach; another client/timeout may answer. |

The card itself shows the facts that change the decision: a sandbox escalation
(`workspace-write → danger-full-access`), the model's `justification` when it
differs from the reason, and a target path with an `outside workspace` marker.
`danger-full-access` is highlighted and `s`/`a` are labelled `DANGER`; the rule
then repeats that full access only for this session or this exact policy entry.
`w` appears only for a file tool under `workspace-write` whose target lies
outside the session workspace, including when the model asked for
`danger-full-access`; it is the narrower alternative to granting everything.

Details are scrollable; `Esc`/`q` returns. Routing modes (`tui`, `auto`, `web`,
`off`), grace periods, and optional whitelist + LLM auto-approval are in
[Configuration](configuration.md).

```text
/approvals             status
/approvals on|off      enable or disable
/approvals add <json>  append a rule
/approvals remove <id> remove a rule
/approvals suggest     propose a rule from the last approval

/sandbox                    list this session's runtime writable roots
/sandbox allow-dir <path>   register a directory for this session
/sandbox revoke-dir <path>  remove a registered directory
```

Edit `auto-approve.toml` for mode, policy, full-access, and limits; it reloads
within 2 seconds.

`/approvals suggest` asks the model for a rule based on the last approval; it is
saved only after `y` confirmation. Late attach replays pending requests on
Host 0.8.0+.

### Session rules and writable roots

`s` and `a` share one deterministic rule: the bash program plus subcommand
(`npm test`), or the exact resolved path for a file tool. It never copies
arguments such as image tags, revisions, or inline code. The rule is:

- **scoped** to this session and to the sandbox the call requested;
- **in memory** for `s`; cleared on session switch or client restart;
- **mirrored to the Host** when it advertises `approval.session-allow`, so a
  matching later call is allowed inside the `approval/request` waterfall
  without opening a panel in any terminal. Other terminals and `--exec` share
  that decision. A failing or absent mirror leaves the client-only behavior.

Host-side matching fails closed: a missing `callId`, a missing tool call in the
session log, arguments that are not a JSON object, an unparseable shell line, or
a `danger-full-access` request without an explicit full-access rule all fall
back to the normal interactive approval.

A background `/btw fork` child approval reaches the parent terminal but belongs
to another session, so its panel offers only allow, reject, details, and detach.
`approvals: off` also takes precedence: mirrored rules are not evaluated.

`w` and `/sandbox allow-dir` call `ctx.sandboxPolicy.registerWritableRoot()`.
Grants are runtime-only: they disappear on detach, session switch, Host restart,
or resume/fork. The path must be an existing absolute physical directory;
`--cache-root` is registered automatically when a session opens. A Host without
`sandboxPolicy` (or a missing directory) is reported as unsupported/not
registered and never blocks session open.

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

After Host restart or a dropped connection, the client retries and reopens the
session; `/reconnect` forces it. A durably interrupted last turn gets one
continuation prompt with a stable request id. `DSH_ATTACH_AUTO_RESUME=0`
disables it. Pending approvals or questions from the old process may be lost.

Remote mode is stricter and more forgiving at the same time:

- SSH keepalives (`ServerAliveInterval=10`, `ServerAliveCountMax=3`) detect a
  dead link. The heartbeat request is additionally bounded (5s in remote mode);
  a timeout treats the connection as half-open and forces a fresh SSH proxy.
- Reconnect failures back off `1s, 2s, 5s, 10s, 15s` with jitter and a 15s
  connect timeout. Non-retryable errors such as `attach/ssh-auth`,
  `attach/ssh-remote-bin`, or `attach/ssh-failed` stop automatic retries and
  show what to fix.
- After reconnecting on the same session, the client re-mirrors session
  approval rules (`s`) and re-grants writable roots (`w`/`/sandbox allow-dir`)
  best-effort, so a short drop does not break an in-flight turn.
- Remote `--exec` also survives a mid-turn drop: it reconnects for up to 60
  seconds, re-opens the same session, re-applies `--allow-dir` roots, and
  inspects the fresh snapshot. If the turn finished while disconnected it
  returns the final assistant text and usage as a normal success; if it is
  still running it resumes waiting. If the window expires it fails with
  `attach/closed` and keeps `sessionId` for `-s`.

## Multiple terminals

TUI-mode approvals/questions broadcast to all TUIs on the session; first answer
wins. With `approvals: first-win`, the terminal and native Web approval panels
are opened together; the first accepted answer wins and the companion closes
the Web panel. The terminal follows one session at a time; other sessions keep running.

## Mouse and focus

Default is button-motion tracking (`1002`); `DSH_ATTACH_FULL_MOUSE=1` enables
all-motion (`1003`); `DSH_ATTACH_NO_MOUSE=1` disables mouse/focus reporting.
Focus loss hides the empty-composer cursor.
