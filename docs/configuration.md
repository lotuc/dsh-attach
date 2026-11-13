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
| `approvals` | `tui` | `auto`, `tui`, `web`, or `off`. |
| `questions` | `tui` | Same modes for `ask_user_question`. |
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

`approvalGraceSeconds`/`questionGraceSeconds` delegate only after the terminal
has not acknowledged the panel. A shown terminal panel remains terminal-owned.
Disconnect hands the request to Web or releases it. `0` disables the timer.

Late terminals receive pending interactions from the Host.

## Environment

| Variable | Effect |
|---|---|
| `DSH_HOME` | Host home; default `~/.dsh`. Host and client must agree. |
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
`$DSH_HOME/dsh-attach/auto-approve.json`; override with
`DSH_ATTACH_AUTO_APPROVE` (`off` disables). Client restart required.

The file is read as JSONC: `//` and `/* */` comments and trailing commas are
accepted. `commandPrefix` may be a token array or a compact whitespace-separated
string (`"commandPrefix": "npm test"`). `/approvals add|remove|on|off` rewrites
the file as strict JSON, so comments are lost after a command edit.

Two modes:

| Mode | Behavior |
|---|---|
| `rules` (default) | A structured prefix rule must match; the rule is the authority and no LLM reviewer runs. |
| `review` | Every approval with tool arguments goes to the LLM reviewer under a global policy; no exact rule is required. |

Global review example:

```json
{
  "enabled": true,
  "mode": "review",
  "policy": "Allow reads, tests, builds, and dependency installs. Ask for deletes, credentials, host configuration, and anything outside the workspace.",
  "humanOnly": ["plugin_manager"],
  "humanOnlyPrefixes": [["rm", "-rf"], ["git", "push"], ["sudo"]],
  "allowFullAccess": false,
  "maxAutoApprovals": 20,
  "timeoutMs": 10000
}
```

Rules mode example:

```json
{
  "enabled": true,
  "mode": "rules",
  "rules": [
    { "id": "tests", "tool": "bash", "commandPrefix": ["npm", "test"], "cwdPrefix": "/work/project", "sandbox": "workspace-write" },
    { "id": "jolt-full", "tool": "bash", "commandPrefix": ["jolt", "test"], "sandbox": "danger-full-access", "allowFullAccess": true }
  ]
}
```

Rules match `tool` (or `*`), optional `commandPrefix` (an ordered token array
for bash), optional `pathPrefix` (file tools), optional `cwdPrefix`, and
optional `sandbox`. First match wins, but every non-read-only subcommand in a
compound line must match a rule.

`commandPrefix` is token-based, not regex. A string is accepted as a
whitespace-separated convenience; an array is preferred. An element may be an
array of alternatives, for example `[["clojure", "mvn"]]`. The matcher:

1. splits `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines;
2. rejects substitutions, subshells, heredocs, and loops;
3. strips `timeout`, `nice`, `time`, `nohup`, `command`, `builtin`, `stdbuf`,
   `env`, env assignments, and bare `cd` segments;
4. treats a small built-in read-only set (`echo`, `tail`, `grep`, `wc`, …) as
   always safe;
5. requires every remaining segment to match a rule.

If the shell line cannot be classified safely, auto-approval fails closed.

`/approvals suggest` returns a structured `commandPrefix` (or `pathPrefix`),
validates it against the actual call, and falls back to the first normalized
command prefix if the reviewer returns prose, invalid JSON, or a non-matching
rule.

Hard gates run before the reviewer:

- `humanOnly` tools always ask.
- `humanOnlyPrefixes` token prefixes (for example `[["rm","-rf"],["sudo"]]`)
  always ask.
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

Edit `auto-approve.json` for `mode`, `policy`, `allowFullAccess`,
`humanOnly`, `humanOnlyPrefixes`, `maxAutoApprovals`, and `timeoutMs`. The file
is reread within 2 seconds; a client restart is not needed after editing.

### Debugging auto-approval

`enabled: true` only arms the feature; it does not create a policy. In
`rules` mode an empty `rules` array approves nothing, and in `review` mode an
empty `policy` approves nothing.

Start with:

```text
/approvals
```

The status panel shows the file path, mode, rule count, `max`, and the last
decision (`allowed`, `ask`, `failed`, or `skip` with a reason). A quick
end-to-end check in rules mode:

```text
/approvals add {"id":"all-bash","tool":"bash","command":".*"}
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
| `hard-gate` | `humanOnly`, a `humanOnlyPrefixes` match, or `danger-full-access` without `allowFullAccess`. |
| `max-reached` | The per-session auto-approval cap was reached. |
| `session-mismatch` | A background fork child approval is deliberately left to a human. |

The first event is `approval-received`. If it is absent, this TUI never saw
the approval: another TUI answered first, the Web client handled it, or the
Host is configured with `approvals: web`/`auto` and routed it away. For a
focused debug run set `approvals: tui` in the profile's `cordis.patch.yml`.
Then look for `auto-approval-review`, `auto-approval-allowed`,
`auto-approval-ask`, `auto-approval-failed`, or `auto-approval-skip`.
A timeout, invalid reviewer JSON, missing LLM, or changed session fails to the
human panel rather than approving.

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
