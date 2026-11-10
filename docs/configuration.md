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
