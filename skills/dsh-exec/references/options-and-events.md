# `dsh-attach --exec` Reference

## CLI Options

| Flag | Scope | Description |
|---|---|---|
| `--exec` | exec | Run one prompt headlessly without a TUI and exit. |
| `-p, --prompt <text>` | exec | Inline prompt text. Mutually exclusive with `-f`. |
| `-f, --prompt-file <path>` | exec | Read UTF-8 prompt text from file (`~` expanded). Mutually exclusive with `-p`. |
| `-o, --output <path>` | exec | Write non-empty final assistant text to file (`~` expanded, creates parent dirs). |
| `-s, --session <id>` | exec | Reuse an idle persisted session. Mutually exclusive with `--new`, `-C`, `--preset`. |
| `-C, --cwd <path>` | new | Working directory for a new session (`~` expanded). |
| `--preset <id>` | new | Agent preset for a new session. |
| `--model <provider/model>` | exec | Select model before sending prompt (split at first `/`). |
| `--title <text>` | exec | Rename session before sending prompt. |
| `--permission <mode>` | exec | Apply `/permission <mode>` before prompt: `read-only`, `workspace-write`, `danger-full-access`, `auto`. |
| `--allow-dir <path>` | exec | Register an extra runtime writable root under `workspace-write` (repeatable, `~` expanded). Fails fast if Host lacks `sandbox.roots` or rejects the directory. |
| `--cache-root <path\|@cwd\|@session>` | exec | Redirect language tool caches (Maven, Gradle, npm, pip, Cargo, Go, Clojure, etc.) and auto-register as a writable root. |
| `--json` | exec / list / models | With `--exec`, print one final JSON result object. With `--list`, print `{"items":[...]}` without truncation. With `--models`, print the full model catalog. |
| `--jsonl` | exec | Stream newline-delimited JSON progress events to stdout. Mutually exclusive with `--json`. |
| `--models` | models | Query `model.catalog` and print one `provider/model` entry per line, then exit. Mutually exclusive with `--exec`, `--list`, preview, `--hot`, and `--stdio-proxy`; works with `--json`, `--ssh`, `--remote`, `--profile`, and `--endpoint`. |
| `--approvals <deny\|host>` | exec | Fallback for unmatched approvals/questions: `deny` (default) or `host` (DSH Web UI). |
| `--approval-rules <file\|@default>` | exec | Scoped TOML/JSONC approval rules. `@default` resolves `DSH_ATTACH_AUTO_APPROVE` or `$DSH_HOME/dsh-attach/auto-approve.toml`. |
| `--approve` | exec | Allow every approval for the run (dangerous; mutually exclusive with `--approvals host`). |
| `--exec-timeout <seconds>` | exec | Cancel a stalled turn (default `1800`, `0` waits forever). Exits `124`. |
| `--list` | list | List sessions and exit. Combine with `--json` for machine-readable output and `--all` to include subagents. |
| `--profile <name>` | global | Filter Host endpoint descriptors by DSH profile (e.g. `desktop`, `web`). Forwarded to the remote proxy under `--ssh`. |
| `--ssh <target>` | global | Attach over SSH (`user@host` or an ssh alias) via a remote `--stdio-proxy`; no Host TCP listener. Mutually exclusive with `--socket`/`--hot`. A configured remote alias name is expanded transparently. |
| `--remote <alias>` | global | Attach through a named remote profile from `$DSH_HOME/dsh-attach/remotes.toml` (`DSH_ATTACH_REMOTES` overrides). Mutually exclusive with `--ssh`/`--socket`/`--hot`/`--stdio-proxy`. |
| `--remote-bin <path>` | remote | Explicit remote `dsh-attach` executable; skips the remote probe. Requires `--ssh` or `--remote`. Use a `.cmd` path for a Windows remote. |
| `--ssh-opt <arg>` | remote | Extra argv element forwarded to `ssh`; repeat for `-o value` pairs. Requires `--ssh` or `--remote`. Appended after alias `ssh_opts`. |
| `--stdio-proxy` | internal | Remote-side stdin/stdout proxy used by `--ssh`/`--remote`. Not combined with `--exec`, `--list`, `--preview`, `--hot`, `--ssh`, or `--remote`. |

## Remote Aliases

`dsh-attach remote ...` manages `$DSH_HOME/dsh-attach/remotes.toml`
(`DSH_ATTACH_REMOTES` overrides):

```sh
dsh-attach remote list [--json]
dsh-attach remote add <name> --ssh <target> [--ssh-opt <arg>]... \
  [--remote-bin <path>] [--profile <name>] [--endpoint <path>] \
  [--cache-root <path|@session>] [--force]
dsh-attach remote show <name> [--json]
dsh-attach remote remove <name>      # alias: rm
```

- Alias names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; `ssh` is required.
- `remote add` refuses to overwrite without `--force` and rejects
  `--cache-root @cwd`.
- TOML keys may be snake_case or camelCase; writes use snake_case.
- CLI `--profile`, `--remote-bin`, `--endpoint`, and `--cache-root` override
  alias fields; CLI `--ssh-opt` values append after the alias options.

## Remote Path Rules (`--ssh` / `--remote`)

- `-C/--cwd`, `--allow-dir`, `--endpoint`, and `--cache-root` refer to the
  remote machine and are **not** expanded with the local home/cwd.
- `--cache-root @cwd` is rejected under `--ssh`/`--remote`; use `@session` or
  an explicit remote path. `@session` and explicit remote paths are passed
  through.
- `-f/--prompt-file`, `-o/--output`, `--log`, and `--approval-rules` remain
  local files and still expand `~`.
- `--exec` and `--list` imply SSH `BatchMode=yes`; key/agent auth is required.
- The remote Host must already be running.

Remote reconnect error codes:

| Code | Retryable | Meaning |
|---|---|---|
| `attach/ssh-auth` | no | Permission denied, host-key verification, or unsupported auth. |
| `attach/ssh-remote-bin` | no | Remote `dsh-attach` not found (ssh exit 127). |
| `attach/ssh-failed` | no | SSH connected but the remote command/protocol failed. |
| `attach/stdio-proxy` | no | The remote proxy received a malformed/non-hello first frame. |
| `attach/unreachable` | yes | DNS, refused, reset, broken pipe, or host unreachable. |
| `attach/timeout` | yes | SSH connect or handshake timeout. |
| `attach/closed` | yes | The stream closed before/while connected; used when remote exec recovery expires. |

With `--ssh --exec`, a mid-turn drop gets up to 60 seconds of reconnects on the
same session. If the turn already ended during the outage, the final text and
usage are read from the fresh snapshot and returned with `ok: true`. If
recovery expires, the error payload is `attach/closed` and `sessionId` is
preserved for `-s`.

## Output Schemas

### `--models` and `--models --json`

Plain output prints one routable `provider/model` per line (or
`No models available.`), which is directly usable with `--model`:

```text
deepseek-official/deepseek-flash
magpie/group/codex-auto-review
```

`--json` prints the Host catalog object without modification:

```json
{
  "default": { "provider": "...", "model": "...", "reasoningEffort": "high" },
  "routableProviders": ["..."],
  "groups": [
    {
      "id": "provider-id",
      "name": "Display name",
      "models": [
        { "id": "model-id", "name": "Model name", "reasoning": { "efforts": [], "defaultEffort": "high" } }
      ]
    }
  ]
}
```

### `--list --json`

```json
{
  "items": [
    {
      "sessionId": "session-...",
      "title": "My task",
      "cwd": "/abs/path/to/repo",
      "updatedAt": 1795620300038,
      "running": false,
      "blank": false,
      "parentSessionId": null,
      "origin": null,
      "agentPreset": "standard",
      "model": { "provider": "...", "model": "..." }
    }
  ]
}
```

### `--exec --json`

Success / completed turn:

```json
{
  "ok": true,
  "sessionId": "session-...",
  "turn": 1,
  "text": "Final assistant reply",
  "reason": "completed",
  "failure": null,
  "usage": { "inputTokens": 1200, "outputTokens": 150 },
  "interactions": [],
  "error": null
}
```

Error / timeout (`124`) / interrupt (`130`) / terminated (`143`):

```json
{
  "ok": false,
  "sessionId": "session-...",
  "error": { "code": "attach/exec-timeout", "message": "exec timed out after 60s" }
}
```

### `--exec --jsonl` Events

Each line on stdout is a standalone JSON object with a `type` discriminator.
Deltas, tool events, and interactions interleave as the turn progresses:

- `{"type":"session.started","sessionId":"...","cwd":"..."}`
- `{"type":"text.delta","sessionId":"...","text":"..."}` — streamed assistant text
- `{"type":"reasoning.delta","sessionId":"...","text":"..."}` — streamed reasoning
- `{"type":"tool.call","sessionId":"...","callId":"...","name":"bash","arguments":"{\"command\":\"npm test\"}"}` — `arguments` is a string (objects are JSON-stringified), capped at 16384 chars, with `"truncated":true` added only when capped
- `{"type":"tool.result","sessionId":"...","callId":"...","name":"bash","ok":true,"output":"..."}` — `output` is content text or the error message, capped at 16384 chars with an optional `"truncated":true`; failed calls use `ok:false`
- `{"type":"interaction","sessionId":"...","kind":"approval","requestId":"...","tool":"bash","callId":"...","reason":"...","outcome":"allowed-once","decision":"rule:tests"}`
- `{"type":"turn.end","ok":true,"sessionId":"...","turn":1,"text":"...","reason":"completed","failure":null,"usage":{...},"interactions":[...],"error":null}`
- `{"type":"error","ok":false,"sessionId":"...","error":{"code":"...","message":"..."}}` (on fatal error/timeout/interrupt)

`turn.end` is the last line when the turn settles. `error` replaces it when the
runner throws. Exit codes: `124` timeout, `130` `SIGINT`, `143` `SIGTERM`.

## Scoped Approval Rules (`--approval-rules`)

```toml
enabled = true
mode = "rules"

[[rules]]
id = "tests"
tool = "bash"
command_prefix = ["pnpm", "test"]

[[rules]]
id = "docs"
tool = "write"
path_prefix = "docs/"
```

- `command_prefix` is token-based (not regex); every non-read-only segment in a compound command must match.
- `danger-full-access` escalations require `allow_full_access = true` on both the file and the matching rule.
- Omitting `enabled` in an explicit `--approval-rules <file>` enables it; `enabled = false` explicitly rejects the file.
