# dsh-attach

Attach a terminal UI to DeepSeek Harness. The Host plugin exposes
`sessionController` over a local socket or named pipe; the client sees the same
sessions, turns, approvals, and questions as the Web UI. If DSH is not running,
`dsh-attach` starts it and waits for the bridge.

```text
local dsh-attach --ssh target
  │  ssh -T (keepalives, no remote PTY)
  ▼
remote dsh-attach --stdio-proxy
  │  discovers endpoint.json, injects its rotated token
  ▼
Host process  ◀── local socket / named pipe ──▶  sessionController
```

No second harness, TCP port, account, or login. The Host bridge is local-only
and uses a per-process token. `--ssh` carries that local protocol over stdio, so
the token and the listener never leave the remote host.

## Quick start

Requirements: DSH Desktop or Web installed, the same OS user, and Node.js
`^22.19.0 || >=24.0.0`. The client starts the macOS/Windows desktop app, or
`dsh web` for a CLI-only install, when no attach endpoint is present. With
`--ssh` the remote Host must already be running.

```sh
dsh plugin --profile desktop add ./dsh-attach
dsh-attach --list
dsh-attach --models --json
dsh-attach
dsh-attach --exec -p "fix the failing test"
dsh-attach --ssh user@host                 # remote TUI
dsh-attach --ssh user@host --exec -p "run the tests"
dsh-attach remote add win --ssh user@localhost --ssh-opt -p2233
dsh-attach --remote win                    # same host via a named alias
dsh-attach --ssh win                       # alias names also work with --ssh
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

### Multica integration

`dsh-attach-claude` is a Claude Code CLI-compatible adapter. It accepts
`--print`, `--output-format stream-json`, and `--input-format stream-json`
(orchestrator flags), runs each turn through a live local or remote DSH
Session, and emits Claude `system`/`assistant`/`user`/`result` frames. Register
it as a Claude runtime in Multica:

```sh
multica runtime profile create --runtime-type claude --command-name dsh-attach-claude
```

Useful orchestration settings are environment variables, so they need no
custom flags: `DSH_ATTACH_REMOTE`, `DSH_ATTACH_SSH`, `DSH_ATTACH_PROFILE`,
`DSH_ATTACH_MODEL`, `DSH_ATTACH_PERMISSION`, `DSH_ATTACH_CACHE_ROOT` (default
`@session`), `DSH_ATTACH_APPROVALS`, `DSH_ATTACH_APPROVAL_RULES`, and
`DSH_ATTACH_ALLOW_DIRS`. `--model provider/model` is forwarded; Claude aliases
such as `sonnet` fall back to the DSH default model. See
[Usage](docs/usage.md#multica-integration) for details.

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
  `--jsonl` give dispatchers results and streaming progress (text/reasoning
  deltas, tool calls with bounded arguments, tool results, interactions), the
  session id is printed early so a timeout or `SIGTERM` can resume with `-s`,
  and `--allow-dir`, `--permission`, `--model`, `--preset`, `--title`, `-f`,
  and `-o` scope the run. `--list --json` lists sessions, `--models [--json]`
  prints the Host model catalog, and `--approval-rules` (including `@default`)
  scopes approvals.
- **Claude/Multica adapter**: `dsh-attach-claude` speaks Claude Code's
  `--print`/`stream-json` protocol and drives the same `runExec` path, so a
  Claude-compatible orchestrator can use DSH as its runtime.
- **Remote SSH**: `--ssh <target>` attaches through a remote `--stdio-proxy`
  with no Host TCP listener; `--remote-bin` and repeatable `--ssh-opt` tune the
  hop, and `--exec`/`--list` use non-interactive SSH batch mode. Named aliases
  in `$DSH_HOME/dsh-attach/remotes.toml` reduce a complex host to
  `dsh-attach --remote <alias>`; manage them with
  `dsh-attach remote add|list|show|remove`.
- **Reconnect**: automatic retry after Host restart or a network drop,
  `/reconnect` on demand; remote mode uses longer backoff, detects half-open
  links with a bounded heartbeat, and re-applies session rules/writable roots.
- **Cross-platform**: Unix socket or Windows named pipe on the Host; local and
  remote macOS/Linux/Windows combinations (Windows remotes can use named pipes,
  which a TCP forward cannot). Windows TUI requires a ConPTY terminal.

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

- Host transport: Unix socket or Windows named pipe. No TCP listener.
- Remote attach is SSH stdio: the local client sends `hello` with an empty
  token; the remote proxy injects the descriptor token, so it never crosses to
  the local machine. No TCP forward is needed.
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
- In `--ssh`/`--remote` mode `/desktop` is disabled and local `HERDR_*`
  variables are not forwarded; the remote Host is not auto-started.
- Loaded history defaults to 300 messages; paging reads further back.

## License

MIT. See [LICENSE](LICENSE).
