# Configuration

## Host plugin

Edit the `dsh-attach` entry in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-attach
  config:
    enabled: true
    # socketPath: /run/user/1000/dsh-attach.sock
    approvals: tui
    questions: tui
    activeWindowMinutes: 10
    approvalGraceSeconds: 120
    questionGraceSeconds: 300
    historyMessages: 300
    hotReload: false
```

Apply a profile recomposition or restart DSH after changes.

| Option | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Start the bridge. |
| `socketPath` | `""` | Unix socket or Windows named pipe. Empty selects the platform default. |
| `approvals` | `tui` | `auto`, `tui`, `web`, `off`, or `first-win`. |
| `questions` | `tui` | `auto`, `tui`, `web`, or `off` for `ask_user_question`. |
| `activeWindowMinutes` | `10` | Activity window for `auto`. |
| `approvalGraceSeconds` | `120` | Delegate unanswered approvals; `0` waits forever. |
| `questionGraceSeconds` | `300` | Delegate unanswered questions; `0` waits forever. |
| `historyMessages` | `300` | Snapshot/page size, clamped to `1..5000`. |
| `hotReload` | `false` | Dev: reload `lib/host/server.js` on change. |

Unix: directory `0700`, socket/descriptor `0600`, long paths fall back to the
temp directory. Windows: named pipe; no Unix mode bits.

### Interactive modes

| Mode | Behavior |
|---|---|
| `tui` | Terminal request while it is watching; Web takes over if it disconnects. |
| `auto` | Terminal if recently active or no Web client; otherwise Web. |
| `web` | Web handles it. |
| `off` | Terminal handling disabled. |
| `first-win` | Ask both terminal and native Web together; the first answer wins and the loser closes. |

`approvalGraceSeconds`/`questionGraceSeconds` delegate only after the terminal
has not acknowledged the panel. A shown terminal panel remains terminal-owned.

In `first-win` mode there is no grace handoff: the terminal and the native Web
UI receive the request at the same time. The Host settles the first answer and
broadcasts an `approval.closed` event with the outcome/winner. The bundled Web
companion consumes a same-origin `/dsh-attach/interactions` SSE stream and
resolves the native Web panel with that outcome so it closes cleanly. Without
the Web companion (older client bundle, or Web UI never opened), a terminal win
can leave the native Web panel open even though the decision is already made.
Disconnect hands the request to Web or releases it. `0` disables the timer.

Late terminals receive pending interactions from the Host.

## Environment

| Variable | Effect |
|---|---|
| `DSH_HOME` | Host home; default `~/.dsh`. Host and client must agree. |
| `DSH_ATTACH_NO_START` | Set to `1` to fail instead of starting DSH when no endpoint exists. |
| `DSH_ATTACH_THEME` | `light` or `dark`; `--theme` wins. |
| `DSH_ATTACH_NO_MOUSE=1` | Disable mouse/focus reporting. |
| `DSH_ATTACH_FULL_MOUSE=1` | Keep all-motion mouse tracking (`1003`). |
| `DSH_ATTACH_NO_EXIT_HINT=1` | Suppress reattach hint. |
| `DSH_ATTACH_LOG` | Lifecycle log; `off` disables. |
| `DSH_ATTACH_KEYS=1` | Log raw keys (may include prompt text). |
| `DSH_ATTACH_DETAIL` | Initial `compact`, `standard`, or `verbose`. |
| `DSH_ATTACH_PERF=1` | Frame/input/event-loop diagnostics. |
| `DSH_ATTACH_BELL=0` | Disable completion/interaction bell. |
| `DSH_ATTACH_AUTO_RESUME=0` | Disable auto-continue after Host restart. |
| `DSH_ATTACH_PREVIEW_EXIT_AFTER` | Herdr preview idle timeout; `0` keeps open. |
| `DSH_ATTACH_VERSION` | Recorded in the log `start` entry. |

Herdr facts (`HERDR_*`) are read only when launched by Herdr. See
[Herdr](herdr.md).

## Auto-approval

Disabled by default. Config file:
`$DSH_HOME/dsh-attach/auto-approve.toml`; override with
`DSH_ATTACH_AUTO_APPROVE` (`off` disables). Client restart required.

This policy belongs to the interactive TUI. `--exec` is separate: it rejects
approvals unless `--approve` is passed, or loads its own scoped file with
`--approval-rules` (same schema, unmatched calls follow `--approvals`).
`--approval-rules @default` resolves to the TUI's own file: the
`DSH_ATTACH_AUTO_APPROVE` path when set and not `off`/`0`, otherwise
`$DSH_HOME/dsh-attach/auto-approve.toml`. Explicit paths are read as-is
(`~` expanded).

The file is TOML. A legacy `auto-approve.json`/`.jsonc` override is still
parsed for compatibility. `/approvals add|remove|on|off` rewrites the file in
place; TOML comments are lost after a command edit.

Two modes:

| Mode | Behavior |
|---|---|
| `rules` (default) | A structured prefix rule must match; the rule is the authority and no LLM reviewer runs. |
| `review` | Every approval with tool arguments goes to the LLM reviewer under a global policy; no exact rule is required. |

Global review example:

```toml
enabled = true
mode = "review"
policy = "Allow reads, tests, builds, and dependency installs. Ask for deletes, credentials, host configuration, and anything outside the workspace."
human_only = ["plugin_manager"]
human_only_prefixes = [["rm", "-rf"], ["git", "push"], ["sudo"]]
allow_full_access = false
max_auto_approvals = 20
timeout_ms = 10000
```

Rules mode example:

```toml
enabled = true
mode = "rules"

[[rules]]
id = "tests"
tool = "bash"
command_prefix = ["npm", "test"]  # a string such as "npm test" also works
cwd_prefix = "/work/project"
sandbox = "workspace-write"

[[rules]]
id = "jolt-full"
tool = "bash"
command_prefix = ["jolt", "test"]
sandbox = "danger-full-access"
allow_full_access = true
```

Rules match `tool` (or `*`), optional `command_prefix` (an ordered token array
for bash; TOML key), optional `path_prefix` (file tools), optional `cwd_prefix`,
and optional `sandbox`. First match wins, but every non-read-only subcommand in
a compound line must match a rule.

`command_prefix` is token-based, not regex. It is a prefix rule, equivalent to
a trailing wildcard: `["git", "log"]` matches `git log --oneline main` but not
`git push`. Keep it at program + subcommand; do not copy variable arguments,
paths, image tags, volume mounts, or inline code. A string is accepted as a
whitespace-separated convenience; an array is preferred. An element may be an
array of alternatives, for example `command_prefix = [["clojure", "mvn"]]`.
The matcher:

1. splits `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines;
2. rejects substitutions, subshells, heredocs, and loops;
3. strips `timeout`, `nice`, `time`, `nohup`, `command`, `builtin`, `stdbuf`,
   `env`, env assignments, and bare `cd` segments;
4. treats a small built-in read-only set (`echo`, `tail`, `grep`, `wc`, …) as
   always safe;
5. requires every remaining segment to match a rule.

If the shell line cannot be classified safely, auto-approval fails closed.

`/approvals suggest` returns a short `command_prefix` (program + subcommand,
typically 1-3 tokens) or a `path_prefix`, validates it against the actual call,
and falls back to the same prefix heuristic if the reviewer returns prose,
invalid JSON, or a non-matching rule. It never copies the full argv into a
rule.

Hard gates run before the reviewer:

- `humanOnly` tools always ask.
- `human_only_prefixes` token prefixes (for example
  `[["rm","-rf"],["sudo"]]`) always ask.
- `danger-full-access` requires `allowFullAccess: true` and a matching rule in
  `rules` mode. It grants the entire user-accessible filesystem, not a path
  named in the reason.
- `maxAutoApprovals` caps auto-approvals per session (`0` = unlimited).

In `review` mode the reviewer gets the tool name, parsed arguments, reason,
sandbox modes, policy, and normalized segments. It returns `allow` or `ask`.
Timeout, invalid JSON, missing LLM, missing tool arguments, or changed session
falls back to the human panel. The reviewer uses the session model; `rules`
mode never invokes it.

Auto-approval is advisory, not a security boundary: arguments and reasons are
untrusted and can attempt prompt injection. Keep the config outside the
workspace and review it as executable policy. `/status` shows mode/rules;
decisions are logged as `auto-approval-*` in `client.log`.

Runtime commands:

```text
/approvals             status
/approvals on|off      enable or disable
/approvals add <json>  append a rule
/approvals remove <id> remove a rule
/approvals suggest     LLM suggests a rule for the last approval; requires y to add
```

`/approvals suggest` falls back to the first normalized command prefix (or
literal path) if the reviewer returns prose, invalid JSON, or times out; the
confirmation panel says when that fallback was used.

Edit `auto-approve.toml` for `mode`, `policy`, `allow_full_access`,
`human_only`, `human_only_prefixes`, `max_auto_approvals`, and `timeout_ms`.
The file is reread within 2 seconds; a client restart is not needed after
editing.

### Debugging auto-approval

`enabled = true` only arms the feature; it does not create a policy. In
`rules` mode no `[[rules]]` approves nothing, and in `review` mode an empty
`policy` approves nothing.

Start with:

```text
/approvals
```

The status panel shows the file path, mode, rule count, `max`, and the last
decision (`allowed`, `ask`, `failed`, or `skip` with a reason). A quick
end-to-end check in rules mode:

```text
/approvals add {"id":"debug-pwd","tool":"bash","commandPrefix":["pwd"]}
```

If that works, narrow the rule. If it still asks, the `last` line or the log
shows why. Decisions and skip reasons are logged:

```sh
tail -f "$DSH_HOME/dsh-attach/client.log" | grep --line-buffered auto-approval
```

Common skip reasons:

| Reason | Meaning |
|---|---|
| `disabled` | `/approvals off`, or the config is not enabled. |
| `rules-empty` | `mode: rules` with no rules. Add one or switch to `review`. |
| `review-policy-empty` | `mode: review` with an empty `policy`. |
| `context-unavailable` | The approval has no rendered tool call or its arguments are not valid JSON. The tool name/arguments are missing, so no rule can be evaluated safely. |
| `no-rule` | A non-read-only subcommand did not match any rule, or the shell line was unparseable. |
| `hard-gate` | `human_only`, a `human_only_prefixes` match, or `danger-full-access` without `allow_full_access`. |
| `max-reached` | The per-session auto-approval cap was reached. |
| `session-mismatch` | A background fork child approval is deliberately left to a human. |

The first event is `approval-received`. If it is absent, this TUI never saw
the approval: another TUI answered first, the Web client handled it, or the
Host is configured with `approvals: web`/`auto` and routed it away. For a
focused debug run set `approvals: tui` in the profile's `cordis.patch.yml`.
Then look for `auto-approval-allowed`, `auto-approval-failed`, or
`auto-approval-skip`; `rules` mode is deterministic and does not emit
`auto-approval-review`. In `review` mode, a timeout, invalid reviewer JSON,
missing LLM, or changed session fails to the human panel rather than approving.

## Session approvals and writable roots

The approval panel's `s`, `a`, and `w` actions complement the durable
auto-approval file. They are separate mechanisms with separate lifetimes.

### `s`: allow this session

`s` derives one deterministic rule from the current call:

- bash: the program and, for known subcommand tools (`git`, `npm`, `docker`,
  `clojure`, …), the subcommand, for example `["npm", "test"]`;
- file tools: the resolved target path, for example
  `/work/project/notes.txt`;
- the sandbox the call requested, when it requested one.

The sandbox scope is exact: a rule derived from a call with no requested sandbox
matches only later calls that also request none, and a rule derived from a
`workspace-write` retry matches only that mode. A later escalation therefore
needs its own `s` instead of inheriting a narrower approval.

The rule never copies variable arguments or inline code. A mixed compound line
(`npm test && rm -rf build`) has no single narrow rule, so `s`/`a` are not
offered rather than writing a rule the matcher would refuse to reuse. The rule
is kept in client memory, cleared when the Session changes or the client
restarts, and used to auto-allow later matching approvals in this terminal. For a
`danger-full-access` prompt the action is labelled `DANGER`; the rule then
repeats full access for this session, and only because the human chose `s` on
that exact prompt.

When the Host advertises `approval.session-allow`, the client also sends the
rule to `approval.allowSession`. The Host keeps it per Session and per
connection, evaluates it in the `approval/request` waterfall before any
answerer starts, and returns `allowed-once` immediately on a match. That keeps
`tui`, `first-win`, `web`, and `--exec` consistent: a matching call never opens
a panel, and a non-matching call follows the configured routing mode normally.
`approvals: off` takes precedence over mirrored rules: the bridge takes no part
and delegates every request. Host rules are cleared when the connection closes,
switches Session, or the Host stops.

A background `/btw fork` child approval is still routed to the parent terminal,
but it belongs to another Session. Its panel offers only allow/reject/details/
detach; `s`, `a`, `r`, and `w` are disabled so no rule, writable root, or
rejection note can attach to the parent Session.

Evaluation fails closed. No allow is produced when any of these is true:

- the request has no `callId`;
- the Session log has no `tool/call` event for that `callId`;
- the tool arguments are not a JSON object;
- the shell line cannot be classified safely (substitution, heredoc, loop,
  unmatched quote);
- a compound line contains a non-read-only segment outside the prefix;
- `danger-full-access` is requested without an explicit full-access rule;
- the rule file/aggregate cannot be read.

An older Host without `approval.session-allow` simply never receives the
mirror request; `s` stays terminal-local, and the panel still works.

### `a`: always allow

`a` previews the same rule in a confirmation panel and, on `y`, appends it to
`auto-approve.toml` with a generated `session-<tool>-<target>` id, enables
auto-approval if it was disabled, and allows the current call once. The rule is
then an ordinary durable rule; edit or remove it with `/approvals`. In `review`
mode `a` is not offered: the reviewer ignores `[[rules]]`, so the only effect
would be flipping the global `allow_full_access` switch.

A `danger-full-access` rule requires the explicit marker stored in the rule
(`allow_full_access = true`) and also enables the global `allow_full_access`
switch, because the durable matcher's hard gate checks both. The confirmation
panel says this.

### `r`: reject with a note

The DSH `ApprovalOutcome` has no rejection reason, so `r` rejects first and
then opens a one-line prompt. A non-empty note is sent with `session.prompt`:
`steer` while a turn is running, otherwise `queue`. Submitting an empty note
just closes the prompt. `Esc` closes it without sending anything.

### `w`: allow a directory for this session

Under `workspace-write`, a file tool (`write`/`edit`) whose resolved target lies
outside the session workspace offers `w`, including when the approval asks for
`danger-full-access`. It registers the target's parent directory with
`ctx.sandboxPolicy.registerWritableRoot(session, directory)` and then allows the
call once, instead of widening the whole session to `danger-full-access`.
Approvals that carry a shell command never offer `w`.

Runtime commands:

```text
/sandbox                    list this session's registered roots
/sandbox allow-dir <path>   register one directory
/sandbox revoke-dir <path>  remove this connection's grant
```

The Host advertises `sandbox.roots` only when
`@deepseek-ai/dsh-sandbox-policy` is mounted. On an older Host the commands
report that the route is unavailable and `w` is not offered.

Validation happens before `registerWritableRoot`:

- the path must be absolute, under 4096 characters, and contain no NUL byte;
- `~` and `~/...` targets are expanded with the user's home directory before
  the outside-workspace check and the `w` grant;
- `realpath` must resolve it to an existing directory (symlinks are resolved,
  because DSH rejects symlinked execution paths);
- a filesystem root (such as `/`) is refused; that breadth is only available
  through the explicit `danger-full-access` flow;
- a missing, relative, non-directory, or root path returns
  `attach/invalid-root`; a service-level `SANDBOX_INVALID_ROOT` only leaves the
  root unregistered.

A resolved `--cache-root` is registered automatically when `session.open`
binds it, so cache writes do not require a separate grant. Grants are
runtime-only and per Session: they are not persisted and disappear on detach,
Session switch, Host stop, or resume/fork. Reopening a Session registers the
cache root again.

Headless exec uses the same routes explicitly. `--exec --allow-dir <path>`
(repeatable) calls `sandbox.allowDir` after the Session opens and before the
prompt. Because the caller required that writable root, exec fails before
prompting when the Host does not advertise `sandbox.roots`, rejects the
directory (`attach/invalid-root`), or returns it unregistered. `--exec
--permission <preset>` runs `/permission <preset>` through `commands.execute`
at the same point; a Host without a command registry, or a command that does
not run, fails the exec instead of silently keeping the previous sandbox.

## Themes

```sh
dsh-attach --theme dark
DSH_ATTACH_THEME=dark dsh-attach
```

| Token | Light | Dark |
|---|---:|---:|
| accent | 25 | 111 |
| green | 28 | 114 |
| red | 160 | 203 |
| yellow | 130 | 221 |
| gray | 242 | 244 |
| faint | 246 | 240 |
| cyan | 30 | 116 |
| purple | 91 | 141 |
| orange | 166 | 215 |
| code | 94 | 180 |
| panel background | 254 | 235 |

Theme affects client rendering only.

## Custom bridge address

```yaml
- id: dsh-attach
  config:
    socketPath: /run/user/1000/dsh-attach.sock
```

```sh
dsh-attach --socket /run/user/1000/dsh-attach.sock --token '<token>'
# Windows: --socket \\.\pipe\dsh-attach-<pid> --token '<token>'
```

The token is a per-process secret. Treat it as a password.

## Remote SSH

Remote attach uses the remote machine's own Host configuration and descriptor.
The local client does not read `$DSH_HOME` in `--ssh` mode and never starts a
local Host.

```sh
dsh-attach --ssh user@host
dsh-attach --ssh user@host --profile desktop
dsh-attach --ssh user@host --remote-bin ~/.local/bin/dsh-attach
dsh-attach --ssh user@host --ssh-opt "-o" --ssh-opt "ServerAliveInterval=5"
```

- `--profile` filters the remote descriptor and is forwarded to the proxy.
- `--endpoint` is a **remote** descriptor path; it is forwarded to the proxy
  and is not expanded with the local home directory.
- `--cwd`, `--allow-dir`, and `--cache-root` are also remote paths. `@cwd` is
  rejected in `--ssh` mode; use `@session` or an explicit remote path.
- `--remote-bin` replaces the remote discovery probe. This is the reliable way
  to target a Windows remote, for example
  `--remote-bin 'C:\Users\me\.dsh\profiles\desktop\node_modules\.bin\dsh-attach.cmd'`.
- `--ssh-opt` is forwarded verbatim, one argv element per flag; repeat it for
  flags that take a separate value.
- `--ssh` cannot be combined with `--socket` or `--hot`.
- The remote Host must already be running; unlike local discovery, SSH attach
  does not auto-start the remote Harness.
- `DSH_ATTACH_NO_START` is evaluated by the machine that runs `dsh-attach`.
  It does not affect the remote proxy, which only discovers endpoints.

SSH keepalives (`ServerAliveInterval=10`, `ServerAliveCountMax=3`) and
`ConnectTimeout=10` are always sent; `--exec` and `--list` also send
`BatchMode=yes`. Put persistent host aliases, users, ports, and identity files
in `~/.ssh/config` and use the alias as the `--ssh` target.
