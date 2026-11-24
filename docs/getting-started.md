# Getting started

## Requirements

- DSH Desktop or Web with `sessionController`; the client can start it.
- Same OS user as the Host.
- Node.js `^22.19.0 || >=24.0.0` for the client.
- Unix socket on Linux/macOS; named pipe on Windows. Windows TUI needs a
  ConPTY terminal such as Windows Terminal.

## Install Host plugin

```sh
dsh plugin --profile desktop add ./dsh-attach
# or from a tarball
pnpm pack
dsh plugin --profile desktop add ./dsh-attach-2026.1117.0958.tgz
```

If `dsh` is not on `PATH` on macOS:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add ./dsh-attach
```

The first install requires DSH to load the bundle. Later upgrades can use
Plugin Manager/profile recomposition or HMR; a manual `pnpm install` alone does
not notify DSH.

Web profile:

```sh
dsh plugin --profile web add ./dsh-attach
```

## Check endpoint

```sh
ls -l "${DSH_HOME:-$HOME/.dsh}/dsh-attach/"
```

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\dsh-attach"
```

Expected: `endpoint.json` plus a per-profile descriptor.

## Add client to PATH

Unix:

```sh
ln -sf ~/.dsh/profiles/desktop/node_modules/.bin/dsh-attach ~/.local/bin/dsh-attach
```

Windows:

```powershell
& "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\.bin\dsh-attach.cmd" --help
```

Add the `.bin` directory to `PATH`, or create a `dsh-attach.cmd` shim.

## Run

```sh
dsh-attach                  # interactive picker
dsh-attach -s <session-id>  # open a session
dsh-attach --new -p "run the tests"
dsh-attach --new -C ~/src/project
dsh-attach --list           # non-interactive
dsh-attach --exec -p "run the tests"   # one-shot, no TUI
```

If no endpoint exists, the client starts the desktop app on macOS/Windows, or
`dsh web` when only the CLI is installed, and waits up to 120 seconds. Set
`DSH_ATTACH_NO_START=1` to fail immediately instead. Explicit `--endpoint` and
`--socket` connections never trigger a launch.

The TUI needs a TTY; use `--list` or `--exec` in scripts.

## CLI

| Option | Description |
|---|---|
| `-s`, `--session <id>` | Open a persisted session. |
| `--reattach <id>` | Alias for `--session`. |
| `--preview <id>` | Read-only live preview. |
| `--parent <id>` | Parent session for a subagent preview. |
| `--preview-exit-after <seconds>` | Preview idle timeout; `0` keeps open. |
| `-n`, `--new` | Create and open a session. |
| `-p`, `--prompt <text>` | Submit a prompt after opening. |
| `-C`, `--cwd <path>` | Working directory for a new session. |
| `--cache-root <path\|@cwd\|@session>` | Keep language-tool caches under this directory (off by default); `@cwd` uses the launching directory, `@session` the Session workspace. |
| `--list` | Print sessions and exit. |
| `--all` | Include subagent sessions in `--list`. |
| `--exec` | Run one prompt without a TUI and print the final answer; reads stdin when `--prompt` is omitted. |
| `--json` | With `--exec`, print one JSON result object. |
| `--approvals <deny\|host>` | With `--exec`, reject approvals (default) or delegate them to DSH Web. |
| `--approval-rules <file>` | With `--exec`, load scoped approval rules (TOML/JSONC). |
| `--approve` | With `--exec`, allow every approval (dangerous). |
| `--exec-timeout <seconds>` | Cancel a stalled exec; default 1800, `0` waits forever. |
| `--endpoint <file>` | Use a specific endpoint descriptor. |
| `--socket <path>` | Connect to a socket or named pipe; needs `--token`. |
| `--token <token>` | Token for `--socket`. |
| `--profile <name>` | Filter descriptors by profile. |
| `--theme <name>` | `light` (default) or `dark`. |
| `--log <file>` | Lifecycle log; `off` disables. |
| `--hot` | Dev: restart TUI child on source changes. |
| `-h`, `--help` | Help. |
| `-V`, `--version` | Print version. |

Direct connection:

```sh
dsh-attach --endpoint /path/to/endpoint.json
dsh-attach --socket /path/to/attach.sock --token '<token>'
# Windows: --socket \\.\pipe\dsh-attach-<pid>
```

`--socket` without `--token` falls back to descriptor discovery.

## Listing

`--list` prints `ID`, `AGE`, `STATE`, `CWD`, and `TITLE`. Subagent sessions are
hidden unless `--all` is used. The interactive picker also hides subagents; use
`/subagent list` inside a session.

## Upgrade

1. Install the new package into the same profile.
2. Trigger a DSH profile recomposition or restart DSH.
3. Restart running `dsh-attach` clients.

Protocol mismatches are rejected with an explicit error. Keep the client symlink
if the profile path is unchanged.

## Removal

Remove the bundle from the profile and restart the Host. Delete the client
symlink if created. Stale descriptors can be removed from
`$DSH_HOME/dsh-attach/` when no matching Host is running.

## Next

- [Usage](usage.md)
- [Keys and commands](keybindings.md)
- [Configuration](configuration.md)
