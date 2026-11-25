---
name: dsh-exec
description: Dispatch non-interactive coding, review, research, or multi-turn follow-up tasks to a local DeepSeek Harness (DSH) via `dsh-attach --exec`. Use when the user asks to delegate work to DSH / DeepSeek Harness, run a task in a DSH session, resume an existing DSH session, or list local DSH sessions from another coding agent or script.
license: MIT
compatibility: Requires `dsh-attach` CLI and a local DeepSeek Harness (Desktop or Web) installation with the `dsh-attach` Host plugin enabled.
---

# Dispatch Tasks to DeepSeek Harness (`dsh-attach --exec`)

Use `dsh-attach --exec` to run one-shot or multi-turn prompts against a local DeepSeek Harness (DSH) host without a TTY. Never launch the interactive TUI (`dsh-attach` without `--exec` or `--list`) from an agent shell.

## 1. Preflight

Check that `dsh-attach` is reachable and inspect existing sessions:

```sh
dsh-attach --list --json
```

- If `dsh-attach` is not on `PATH`, check `~/.dsh/profiles/desktop/node_modules/.bin/dsh-attach` (or `node ./bin/dsh-attach.js` inside a local `dsh-attach` checkout).
- Connecting to DSH reads `$DSH_HOME/dsh-attach/endpoint.json` (`~/.dsh` by default) and connects to a local Unix socket (or Windows named pipe). If your outer agent runs inside a restricted sandbox, run `dsh-attach` commands with host/unsandboxed permission.
- If DSH is not running, `dsh-attach` auto-starts it and waits up to 120s. Set `DSH_ATTACH_NO_START=1` to fail fast instead.

## 2. Core Dispatch Patterns

### New implementation task (recommended default)

For non-trivial tasks, write the goal/plan to a file and pass `-f` (avoids shell quoting/piping issues) with `--jsonl` for live progress:

```sh
dsh-attach --exec --jsonl \
  -C /abs/path/to/repo \
  --cache-root @session \
  --permission workspace-write \
  --title "Short task title" \
  -f /abs/path/to/prompt.md \
  -o /abs/path/to/answer.md
```

### Read-only review or research

Enforce a read-only sandbox so DSH cannot modify files:

```sh
dsh-attach --exec --json \
  -C /abs/path/to/repo \
  --permission read-only \
  --title "Code review" \
  -p "Review the uncommitted diff and report bugs or security risks."
```

### Writing to extra directories without `danger-full-access`

Prefer `--allow-dir` (repeatable) over `--approve` or `danger-full-access` when DSH needs to write to sibling repos, shared caches, or output directories under `workspace-write`:

```sh
dsh-attach --exec --jsonl \
  -C /abs/path/to/repo \
  --permission workspace-write \
  --allow-dir /abs/path/to/sibling-repo \
  --allow-dir /abs/path/to/shared-cache \
  -p "Update both repositories and run tests."
```

### Multi-turn follow-up or resuming after timeout

Reuse the same `sessionId` to preserve full conversation context and prompt cache (e.g. sending review fixes back to DSH):

```sh
dsh-attach --exec --json \
  -s <session-id> \
  -p "Fix the two review issues in lib/foo.js and re-run the test suite."
```

- Do **not** pass `-C`/`--cwd` or `--preset` with `-s`/`--session` (they apply to new sessions only).
- The target session must be `idle` (`running: false` in `--list --json`).

### Model, preset, and scoped approvals

```sh
# Select provider/model and agent preset (new session)
dsh-attach --exec --json -C /abs/path/to/repo \
  --preset standard \
  --model provider/model-id \
  -p "Summarize architecture."

# Reuse the user's TUI auto-approval rules
dsh-attach --exec --jsonl -C /abs/path/to/repo \
  --approval-rules @default \
  -p "Run the build and fix failures."
```

## 3. Approvals Policy (Safety Rules)

- **Default (`--approvals deny`)**: Rejects escalated approvals and cancels questions, recording them in `interactions`. Works cleanly for normal `workspace-write` edits and workspace-local commands.
- **Scoped rules (`--approval-rules <file|@default>`)**: Allows only matching deterministic prefixes/paths (or LLM-reviewed calls in `review` mode); unmatched calls fall back to `--approvals`.
- **Host delegation (`--approvals host`)**: Delegates approvals/questions to the open DSH Web/Desktop UI. Requires that UI to be open and Host `approvals` mode not set to `first-win`.
- **`--approve`**: Grants every approval for the run. **Never** pass `--approve` unless the user explicitly asked for it on a trusted workspace.

## 4. Progress, Exit Codes, and Recovery

- With `--jsonl`, read stdout line by line:
  - `session.started` arrives right after `session.open` with `sessionId` and resolved `cwd`.
  - `tool.call` and `interaction` stream as the turn progresses.
  - `turn.end` (or `error`) is the final line.
- With `--json` or plain output, `dsh-attach: session <id>` is printed to stderr immediately after `session.open`.
- Exit codes:
  - `0`: Turn completed (`ok: true`).
  - `1`: Turn failed or Host error.
  - `2`: Invalid CLI arguments, unreadable prompt/rules file.
  - `124`: Timed out (`--exec-timeout <seconds>`, default `1800`, `0` = no timeout).
  - `130`: Interrupted (`SIGINT`).
- On exit `124` or `130`, read `sessionId` from the JSON/JSONL `error` payload (or stderr) and resume with `-s <sessionId>` once the session returns to `idle`.
- After DSH reports completion, independently inspect `git status` / `git diff` (and run project checks if needed) before committing or reporting final success.

## Reference

For the complete CLI flag matrix, JSON/JSONL event schemas, and `approval-rules` TOML format, read [references/options-and-events.md](references/options-and-events.md).
