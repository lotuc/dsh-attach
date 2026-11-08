# Configuration

Configuration has two parts: the Host plugin options and environment variables
read by the terminal client.

## Host plugin configuration

Override the `dsh-attach` entry in the profile's `cordis.patch.yml`, using the
entry ID from the bundle patch:

```yaml
- id: dsh-attach
  config:
    enabled: true
    # socketPath: /custom/path.sock
    approvals: tui
    questions: tui
    activeWindowMinutes: 10
    approvalGraceSeconds: 120
    questionGraceSeconds: 300
    historyMessages: 300
    hotReload: false
```

Restart DeepSeek Harness after changing Host configuration; the bridge is built
at process start and advertises the active modes in its handshake.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Start the socket bridge. `false` keeps the plugin mounted but serves no endpoint. |
| `socketPath` | string | `""` | Override the socket path. Empty uses `$DSH_HOME/dsh-attach/attach-<pid>.sock`. |
| `approvals` | `auto`, `tui`, `web`, `off` | `tui` | Who answers approval requests. |
| `questions` | `auto`, `tui`, `web`, `off` | `tui` | Who answers `ask_user_question` batches. |
| `activeWindowMinutes` | number | `10` | Activity window used by `auto` routing. |
| `approvalGraceSeconds` | number | `120` | Time before an unanswered approval is delegated; `0` waits forever. |
| `questionGraceSeconds` | number | `300` | Time before an unanswered question batch is delegated; `0` waits forever. |
| `historyMessages` | number | `300` | Maximum messages in one follow snapshot and in one older-history page, clamped to `1..5000`. Larger values load more at attach and per `Ctrl+R`/`/history` page; paging does not require raising it. |
| `hotReload` | boolean | `false` | Development only: watch `lib/host/server.js` and restart the bridge in-process when it changes. Requires a restart once to enable. |

The socket directory is created with mode `0700`; the socket and descriptor
files use `0600`. If the default socket path would exceed the platform limit
(about 100 bytes), the Host places the socket in the system temporary directory
instead.

### Routing modes

Approvals and questions use the same mode names independently.

| Mode | Behavior |
|---|---|
| `tui` | While a terminal is watching the session, the request is offered to the terminal. The client sends an activity heartbeat every 20 seconds, so a long turn is not mistaken for inactivity. While the terminal still has the request open, the bridge does not also start the Web answerer; if the terminal disconnects, the request is handed to the Web flow. |
| `auto` | The terminal gets the request if it acted within `activeWindowMinutes`, or if no Web client is live. Otherwise the request goes to the Web GUI. |
| `web` | The bridge does not intercept the request; the Web GUI handles it. |
| `off` | Terminal handling is disabled for that request type. |

### Grace periods

`approvalGraceSeconds` and `questionGraceSeconds` start when the request is
created. On expiry:

1. If a terminal has acknowledged that it displayed the request, it stays
   terminal-owned.
2. Otherwise, if a Web client is live, the request is handed to the Web flow.
3. If no Web client is live, the terminal path is released and the request falls
   through to the remaining Host listeners.

Clients advertise `interactive.ack` in the handshake and send it after the
approval/question panel is actually shown. This prevents a terminal that is
connected but blocked behind another panel from holding the request forever.
Older clients without the capability keep the historical single-owner
behavior.

If the terminal holding the request disconnects, the bridge immediately hands
the pending request to the Web flow when one is live, or releases it otherwise.
Set either value to `0` to disable the timer and keep waiting for an answer.

If a terminal attaches while an interaction is still pending, the Host replays
it for that session. This requires the in-memory pending-interaction support
added in Host plugin 0.8.0.

## Environment variables

| Variable | Effect |
|---|---|
| `DSH_HOME` | Host home directory, default `~/.dsh`. Both the Host and client must agree. |
| `DSH_ATTACH_THEME` | `light` or `dark`. The `--theme` option takes priority. |
| `DSH_ATTACH_NO_MOUSE=1` | Disable mouse reporting and focus reporting. |
| `DSH_ATTACH_FULL_MOUSE=1` | Keep full all-motion mouse tracking (`1003`). By default the client disables `1003` and keeps button-motion tracking (`1002`). |
| `DSH_ATTACH_NO_EXIT_HINT=1` | Suppress the "Reattach with" hint on exit. |
| `DSH_ATTACH_LOG` | Lifecycle log path. `off` disables logging. The `--log` option takes priority. |
| `DSH_ATTACH_KEYS=1` | Log raw key input for debugging. This can include prompt text; use only temporarily. |
| `DSH_ATTACH_DETAIL` | Initial transcript detail: `compact`, `standard` (default), or `verbose`. |
| `DSH_ATTACH_PERF=1` | Emit frame, input-latency, and event-loop diagnostics. |
| `DSH_ATTACH_BELL=0` | Disable the terminal bell when a turn finishes or an approval/question arrives while the terminal is unfocused. |
| `DSH_ATTACH_AUTO_RESUME=0` | Disable the one-time continuation prompt after a Host restart leaves the last turn interrupted. |
| `DSH_ATTACH_PREVIEW_EXIT_AFTER` | Seconds a managed Herdr preview waits after the child becomes idle before exiting; default `0` keeps it open. |
| `DSH_ATTACH_VERSION` | Optional version string recorded in the lifecycle log's `start` entry. |

Herdr injects `HERDR_ENV`, `HERDR_PANE_ID`, and `HERDR_BIN_PATH`; the client
only reads them. See [Herdr integration](herdr.md).

Diagnostics and log details are in [Diagnostics](diagnostics.md).

## Themes

The default palette is `light`, designed for white or light terminal
backgrounds. `--theme dark` and `DSH_ATTACH_THEME=dark` switch to the
bright-on-dark palette.

```sh
dsh-attach --theme dark
# or
DSH_ATTACH_THEME=dark dsh-attach
```

Palette values use 256-color foreground indexes:

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

The theme affects only client rendering. It is not sent to the Host and does not
change model or session behavior.

## Custom socket paths

A custom `socketPath` is useful when the default path is too long or when
managing multiple Hosts:

```yaml
- id: dsh-attach
  config:
    enabled: true
    socketPath: /run/user/1000/dsh-attach.sock
```

The client normally discovers endpoint descriptors automatically. To connect
without descriptor discovery, use:

```sh
dsh-attach --socket /run/user/1000/dsh-attach.sock --token '<token>'
```

The token is generated per Host process and is stored in the descriptor. Treat
it as a password for the local Harness.
