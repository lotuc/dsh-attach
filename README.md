# dsh-attach

Attach a terminal UI to DeepSeek Harness. The Host plugin exposes
`sessionController` over a local socket or named pipe; the client sees the same
sessions, turns, approvals, and questions as the Web UI. If DSH is not running,
`dsh-attach` starts it and waits for the bridge.

```text
Host process  ◀── local socket / named pipe ──▶  dsh-attach
sessionController                               terminal UI
```

No second harness, TCP port, account, or login. The bridge is local-only and
uses a per-process token.

## Quick start

Requirements: DSH Desktop or Web installed, the same OS user, and Node.js
`^22.19.0 || >=24.0.0`. The client starts the macOS/Windows desktop app, or
`dsh web` for a CLI-only install, when no attach endpoint is present.

```sh
dsh plugin --profile desktop add ./dsh-attach
dsh-attach --list
dsh-attach
dsh-attach --exec -p "fix the failing test"
```

Windows: run from Windows Terminal/ConPTY and use:
`%USERPROFILE%\.dsh\profiles\desktop\node_modules\.bin\dsh-attach.cmd`.

The first install must be loaded by DSH. Later upgrades can apply through
Plugin Manager/profile recomposition or HMR without a full app restart.

### Agent skill (`npx skills`)

Install the bundled [dsh-exec](skills/dsh-exec/SKILL.md) skill so other coding
agents (Claude Code, Codex, Cursor, Antigravity, etc.) can dispatch tasks to
DSH via `dsh-attach --exec`:

```sh
npx skills add lotuc/dsh-tui-attach@dsh-exec -g -y
# or from a local checkout
npx skills add ./dsh-tui-attach --skill dsh-exec -g -y
```

See [Getting started](docs/getting-started.md) for install and CLI details.

## Features

- **Sessions**: list, resume, create, fork, archive/unarchive, pin/unpin, presets.
- **Live view**: streaming text/reasoning/tools, turn folding, timestamps,
  activity labels, token/context/permission status.
- **Interaction**: approvals with risk facts, session/always/reject-note quick
  actions, questions, optional whitelist + LLM auto-approval (`/approvals`),
  runtime session writable roots (`/sandbox`), first-win approvals across TUI
  and native Web, goals, plan mode, todo list, queue.
- **Search and history**: `/find`, `Ctrl+R`/`/history`, durable older pages.
- **Subagents**: lineage, read-only history, continue/interrupt, parent navigation.
- **Cache isolation**: `--cache-root <path|@cwd|@session>` keeps Clojure, Maven, Gradle and other tool caches out of the home directory.
- **Commands**: `/` completion for local/Host commands and arguments; Host
  command passthrough.
- **Side questions**: streamed `/btw` overlay with a replayable side thread; `f` starts a background fork with full tool access.
- **Detail levels**: `Ctrl+G` or `/detail compact|standard|verbose`.
- **Jobs and Herdr**: background-job output; Herdr state, titles, preview panes.
- **Auto-start**: launches DSH when it is not running, then waits for the attach bridge.
- **Command-line exec**: `--exec` runs one prompt without a TUI; `--json` and
  `--jsonl` give dispatchers results and streaming progress, the session id is
  printed early so a timeout can resume with `-s`, and `--allow-dir`,
  `--permission`, `--model`, `--preset`, `--title`, `-f`, and `-o` scope the
  run. `--list --json` lists sessions; `--approval-rules` (including
  `@default`) scopes approvals.
- **Reconnect**: automatic retry after Host restart, `/reconnect` on demand.
- **Cross-platform**: Unix socket or Windows named pipe; Windows TUI requires a
  ConPTY terminal.

## Documentation

| Guide | Contents |
|---|---|
| [Getting started](docs/getting-started.md) | Requirements, install, CLI, upgrade |
| [Usage](docs/usage.md) | Sessions, prompts, approvals, subagents, jobs |
| [Keys and commands](docs/keybindings.md) | Keyboard and slash-command reference |
| [Configuration](docs/configuration.md) | Host options, env vars, themes |
| [Herdr](docs/herdr.md) | Agent status and preview panes |
| [Diagnostics](docs/diagnostics.md) | Logs, exit reasons, performance |
| [Security](docs/security.md) | Trust boundary and transport |
| [Troubleshooting](docs/troubleshooting.md) | Common failures |
| [Development](docs/development.md) | Architecture, protocol, tests, release |

## Security

- Local-only transport: Unix socket or Windows named pipe. No TCP listener.
- Timing-safe 32-byte token authentication.
- Unix socket/descriptor use owner-only permissions; Windows relies on ACLs
  plus the token.
- Rendered Host/model output is sanitized for terminal control sequences.
- Anyone who can connect can operate that Harness.

See [Security](docs/security.md).

## Limitations

- Clipboard-only image input; no `@` file indexing or file upload.
- One session per terminal; other sessions keep running.
- Subagent history is read-only; control is limited to follow-up messages and
  interrupt.
- Herdr integration is Unix-only.
- Loaded history defaults to 300 messages; paging reads further back.

## License

MIT. See [LICENSE](LICENSE).
