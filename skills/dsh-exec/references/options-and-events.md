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
| `--json` | exec / list | With `--exec`, print one final JSON result object. With `--list`, print `{"items":[...]}` without truncation. |
| `--jsonl` | exec | Stream newline-delimited JSON progress events to stdout. Mutually exclusive with `--json`. |
| `--approvals <deny\|host>` | exec | Fallback for unmatched approvals/questions: `deny` (default) or `host` (DSH Web UI). |
| `--approval-rules <file\|@default>` | exec | Scoped TOML/JSONC approval rules. `@default` resolves `DSH_ATTACH_AUTO_APPROVE` or `$DSH_HOME/dsh-attach/auto-approve.toml`. |
| `--approve` | exec | Allow every approval for the run (dangerous; mutually exclusive with `--approvals host`). |
| `--exec-timeout <seconds>` | exec | Cancel a stalled turn (default `1800`, `0` waits forever). Exits `124`. |
| `--list` | list | List sessions and exit. Combine with `--json` for machine-readable output and `--all` to include subagents. |
| `--profile <name>` | global | Filter Host endpoint descriptors by DSH profile (e.g. `desktop`, `web`). |

## Output Schemas

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

Error / timeout (`124`) / interrupt (`130`):

```json
{
  "ok": false,
  "sessionId": "session-...",
  "error": { "code": "attach/exec-timeout", "message": "exec timed out after 60s" }
}
```

### `--exec --jsonl` Events

Each line on stdout is a standalone JSON object with a `type` discriminator:

1. `{"type":"session.started","sessionId":"...","cwd":"..."}`
2. `{"type":"tool.call","sessionId":"...","callId":"...","name":"bash"}`
3. `{"type":"interaction","sessionId":"...","kind":"approval","requestId":"...","tool":"bash","callId":"...","reason":"...","outcome":"allowed-once","decision":"rule:tests"}`
4. `{"type":"turn.end","ok":true,"sessionId":"...","turn":1,"text":"...","reason":"completed","failure":null,"usage":{...},"interactions":[...],"error":null}`
5. `{"type":"error","ok":false,"sessionId":"...","error":{"code":"...","message":"..."}}` (on fatal error/timeout/interrupt)

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
