# dsh-attach

Attach a terminal UI to an **already running** DeepSeek Harness host.

`dsh-attach` does not start a second harness. A Host plugin exposes the
live `sessionController` over a local Unix socket, and the `dsh-attach` client
connects to it. You see the same sessions, the same running agent, and the same
approval and question flow. Prompts sent from the TUI go directly into the
running Host and are visible in the Web GUI as part of the same turn.

```text
┌───────────────────────────────┐        Unix socket (0600)        ┌───────────────────────┐
│ DeepSeek Harness Host process │◀────────────────────────────────▶│ dsh-attach (terminal) │
│  sessionController            │   JSONL: request / response      │  pi-tui alternate UI  │
│  approval / user questions    │   session frames / interactive   │  keys / commands      │
└───────────────────────────────┘                                  └───────────────────────┘
```

There is no TCP listener, no extra port, and no separate account or login flow.
The socket and its descriptor live in `$DSH_HOME/dsh-attach/` and are readable
only by the current user.

## Features

- **Same Host, same state**: list, resume, create, fork, archive, and pin
  sessions; read persisted history; subscribe to live tokens, reasoning, and
  tool calls.
- **Session lifecycle**: `/session fork`, `archive`, `unarchive`, `pin`, and
  `unpin` call the same Host services as the Web UI, and the session picker
  offers `f`/`a`/`p` actions on the selected row. Archive respects the Host's
  running-work refusal and accepts `--stop`; DSH has no Session deletion, so
  `/session delete` reports that limitation instead of inventing one.
- **Agent presets**: when the Host mounts the preset registry, `/session
  presets` discloses the roster (including activation failures) and `/session
  preset` or `/session new --preset <id>` selects the preset for new sessions.
- **Live conversation view**: streaming Markdown, code blocks, collapsible
  reasoning and tool output, turn/step state, and a token/context/permission
  status line.
- **Light theme by default**: the default palette is designed for light
  terminals; use `--theme dark` for dark terminals.
- **Searchable pickers**: session and model pickers support `Ctrl+N`/`Ctrl+P`
  and arrows, and filter incrementally as you type. A leading `/` opens the
  command list.
- **Flat session list**: session title first, followed by workspace name,
  workspace path, age, and subagent counts; the current session is selected
  first.
- **Transcript search**: `/find [text]` jumps to a loaded match or opens an
  incremental picker; the activity line marks Host-side history limits and
  locally trimmed rows.
- **Older-history paging**: `Ctrl+R` or `/history` reads the next older page
  from DSH's durable Session log, anchored to the reader's scroll position. The
  loaded transcript grows at the top without disturbing live follow; reconnect
  starts again from a fresh snapshot.
- **Subagent visibility and control**: parent sessions show agent counts,
  `/subagent list` shows the lineage, and subagent history opens read-only.
  `/subagent continue` delivers a follow-up to a continuable child;
  `/subagent interrupt|stop|cancel` stops a running child after confirmation.
  `/subagent parent` goes back.
- **Command completion**: local commands and Host-registered commands appear
  from `/`; grouped commands such as `/session resume`, `/session fork`,
  `/session preset`, and `/job output` complete their arguments, as does
  `/model`; relative file paths complete from the session working directory.
- **Floating completion panel**: completions render above the composer without
  changing its height or pushing the input around.
- **Emacs-style editing**: `Ctrl+N/P` move through the editor, completions,
  pickers, and question options; `Ctrl+A/E/B/F` move by line or character;
  `Ctrl+K/U/W/Y` kill and yank.
- **Approvals and questions**: approval requests appear as panels; `y` allows
  once, `n` rejects, `Enter`/`d` opens the full request and command in a
  scrollable read-only view, and `Esc` detaches this terminal without answering.
  `ask_user_question` supports single select, multi select, custom text, and plan
  approval.
- **Goals and plan mode**: `/goal` shows phase, rounds, activation, and blocked
  reason, with create/edit/pause/resume/complete/clear actions; `/plan` enters,
  leaves, or inspects plan mode. Destructive goal actions require an explicit
  `y` confirmation, and plan approval stays in the plan-review question panel.
- **Host command passthrough**: unknown slash commands such as `/compact` are
  executed by the Host command registry instead of being sent as model prompts.
- **Todo list**: `/todo` shows the model's current plan with pending,
  in-progress, and completed markers; the activity line carries the active
  count.
- **Turn-level detail**: completed turn work folds into one timestamped
  duration/tool-call summary; `Ctrl+G` cycles `compact`, `standard`, and `verbose`, and `/detail`
  sets a level directly.
- **Skill catalog**: `/skill list|show|run` lists user-invocable skills,
  inspects instructions, and invokes them; user skill names also complete in the
  `/` menu and can be typed as `/name`.
- **Visible pending queue**: local prompts keep a `queued` / `steering` marker
  until the Host claims them, pending inbox messages from other clients render
  above the composer, and `/queue` opens a manager for full view, edit,
  steer-now, and removal.
- **Interrupt**: press `Esc` twice within 750 ms, or run `/cancel`, to stop the
  running turn without quitting the client. In a subagent history view this
  opens a confirmation before interrupting that child.
- **Automatic reconnect**: after a Host or desktop-app restart, the client
  retries with backoff and reopens the current session; `/reconnect` forces a
  fresh attempt.
- **Background jobs**: `/job list` lists the session roster, opens live read-only
  output with the original command/label, returns there on `Esc`, refreshes on
  demand, and stops a running job after a two-press confirmation; `d` in the
  output view opens full untruncated job details. The activity line shows the
  live-job count.
- **Herdr integration**: reports `idle` / `working` / `blocked` state and a
  resume command when running inside a Herdr pane, shows the session title in
  pane lists, opens managed subagent preview panes that can auto-close after an
  opt-in idle timeout, and forwards `HERDR_*` facts to model shell commands.
- **Local-only security**: owner-only Unix socket, a per-process random token,
  constant-time token comparison, and terminal control-sequence sanitization.

## Quick start

Requirements: a running DeepSeek Harness Desktop or Web host, the same OS user
as that host, and Unix-domain socket support (Linux or macOS). The
`dsh-attach` client requires Node.js `^22.19.0 || >=24.0.0`; the Host plugin runs
inside DeepSeek Harness.

1. Install the Host plugin into the profile and restart DeepSeek Harness:

   ```sh
   dsh plugin --profile desktop add ./dsh-attach
   ```

   To install from a packed tarball instead:

   ```sh
   pnpm pack
   dsh plugin --profile desktop add ./dsh-attach-2026.1108.2341.tgz
   ```

2. Put `dsh-attach` on `PATH`. The installed binary lives under the profile:

   ```sh
   ln -sf ~/.dsh/profiles/desktop/node_modules/.bin/dsh-attach ~/.local/bin/dsh-attach
   ```

3. Start the client:

   ```sh
   dsh-attach                  # pick a session interactively
   dsh-attach --list           # print sessions and exit
   dsh-attach -s <session-id>  # open a specific session
   dsh-attach --new -p "run the tests"
   dsh-attach --theme dark     # dark terminal palette
   ```

For the Web profile, install with `dsh plugin --profile web add ./dsh-attach`
and restart `dsh web`.

See [Getting started](docs/getting-started.md) for the complete installation and
CLI reference.

## Documentation

| Guide | Contents |
|---|---|
| [Getting started](docs/getting-started.md) | Requirements, installation, first run, CLI reference, upgrade and removal |
| [Usage](docs/usage.md) | Sessions, prompts, approvals, questions, subagents, attach behavior |
| [Keys and commands](docs/keybindings.md) | Complete keyboard and slash-command reference |
| [Configuration](docs/configuration.md) | Host plugin configuration, environment variables, themes |
| [Herdr integration](docs/herdr.md) | Agent status reporting, managed preview pane setup, optional auto-close |
| [Diagnostics](docs/diagnostics.md) | Lifecycle log, exit reasons, focus debugging, performance |
| [Security](docs/security.md) | Trust boundary, socket authentication, terminal injection |
| [Troubleshooting](docs/troubleshooting.md) | Common failures and fixes |
| [Development](docs/development.md) | Architecture, protocol, source map, tests, release checklist |

## Security at a glance

- The bridge listens on a Unix socket under `$DSH_HOME/dsh-attach/` only.
  The directory is `0700`; the socket and descriptor are `0600`.
- Clients must present the 32-byte random token from the descriptor. The Host
  compares a SHA-256 hash with `timingSafeEqual`.
- Model output, tool output, question text, and titles are stripped of CSI/OSC
  and dangerous C0/C1 control sequences before rendering.
- Connecting to the socket grants the same session and agent permissions as the
  current user. **Anyone who can connect can operate that Harness.**

Read [Security](docs/security.md) for the full model.

## Known limitations

- Image input is clipboard-only (`Ctrl+V`, `Ctrl+Shift+V`, or `/image paste`);
  `Ctrl+V` falls back to clipboard text when no image is present. File upload
  and `@` file indexing are not wired up.
- One session per terminal at a time. Other sessions keep running in the Host.
- The client reconnects automatically after a Host or desktop-app restart and
  continues a durably interrupted last turn once; pending approvals/questions
  from the old Host process may be lost. Set `DSH_ATTACH_AUTO_RESUME=0` to
  disable automatic continuation.
- No trajectory timeline, session fork, or diff preview. Subagent history is
  read-only; control covers text follow-up messages and interrupting the current
  turn. The TUI cannot dispatch a new subagent, release a child activation, or
  route a subagent approval/question to the parent terminal.
- Windows is untested; the transport assumes Unix-domain sockets.
- The client loads the most recent 300 messages by default (configurable with
  the Host's `historyMessages`); `Ctrl+R`/`/history` pages further back through
  the durable Session log.

## License

MIT. See [LICENSE](LICENSE).
