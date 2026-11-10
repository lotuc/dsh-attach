# Getting started

## Requirements

- DeepSeek Harness with a Desktop or Web host that provides the
  `sessionController` domain. Current Desktop and Web profiles both do.
- The terminal client must run as the **same OS user** as the Host.
- Linux/macOS use an owner-only Unix-domain socket; Windows uses a named pipe.
  On Windows, run the client in Windows Terminal or another ConPTY terminal.
- Node.js `^22.19.0 || >=24.0.0` for the `dsh-attach` client. The Host plugin
  runs inside DeepSeek Harness.

## Install the Host plugin

From a checkout of this repository:

```sh
dsh plugin --profile desktop add ./dsh-attach
```

`dsh plugin` adds the package to the profile's `dsh.profile.bundles`, installs
its dependencies, and mounts the `dsh-attach` entry declared in
`cordis.patch.yml`.

If `dsh` is not on `PATH` (for example when using the desktop app), call the
launcher bundled with the app directly on macOS:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add ./dsh-attach
```

To install from a packed tarball:

```sh
pnpm pack
dsh plugin --profile desktop add ./dsh-attach-2026.1110.1345.tgz
```

For the Web profile, use the same command with `--profile web`, then restart
`dsh web`:

```sh
dsh plugin --profile web add ./dsh-attach
```

The first install needs DeepSeek Harness to load the new bundle. After that,
DSH's profile HMR/Plugin Manager can recompose the plugin without a full app
restart. A manual `pnpm install` does not notify HMR; trigger a Plugin Manager
operation or update the profile patch to cause a recomposition.

### Check the endpoint

After the Host has loaded the bundle, it writes an endpoint descriptor:

```sh
ls -l "${DSH_HOME:-$HOME/.dsh}/dsh-attach/"
```

PowerShell:

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\dsh-attach"
```

You should see `endpoint.json` plus a per-profile descriptor. If the directory
does not exist or stays empty after a restart, see
[Troubleshooting](troubleshooting.md).

## Put `dsh-attach` on `PATH`

The client binary is installed in the profile's `node_modules/.bin` directory:

```sh
~/.dsh/profiles/desktop/node_modules/.bin/dsh-attach --help
```

On Unix, create a symlink somewhere already on `PATH`:

```sh
mkdir -p ~/.local/bin
ln -sf ~/.dsh/profiles/desktop/node_modules/.bin/dsh-attach ~/.local/bin/dsh-attach
```

On Windows, use the generated shim:

```powershell
& "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\.bin\dsh-attach.cmd" --help
```

Add that `.bin` directory to `PATH`, or create a `dsh-attach.cmd` shim in a
directory already on `PATH`. Adjust the profile path for the Web profile or a
custom `DSH_HOME`.

## First run

With no arguments, `dsh-attach` opens the session picker:

```sh
dsh-attach
```

The picker groups sessions by Workspace (or by `cwd` when Workspace data is
unavailable), expands the current and running groups, and filters titles,
working directories, and descriptions as you type. Press `Enter` to open a
session.

Common first commands:

```sh
dsh-attach -s <session-id>              # open an existing session
dsh-attach --new -p "run the tests"     # create a session and submit a prompt
dsh-attach --new -C ~/src/project       # create a session in a directory
dsh-attach --list                       # non-interactive session list
```

The TUI requires a TTY. Use `--list` for scripts and non-interactive output.

## CLI reference

| Option | Description |
|---|---|
| `-s`, `--session <id>` | Open a persisted session directly. |
| `--reattach <id>` | Attach to a session again; alias for `--session`. |
| `--preview <id>` | Run a read-only live preview of one session, with no editor. |
| `--parent <id>` | Durable parent session for a subagent preview. |
| `--preview-exit-after <seconds>` | Exit a preview after this much idle time; `0` keeps it open. |
| `-n`, `--new` | Create a new session and open it. |
| `-p`, `--prompt <text>` | Submit this prompt after opening. |
| `-C`, `--cwd <path>` | Working directory for a new session. |
| `--list` | Print sessions in a table and exit. |
| `--all` | Include subagent sessions in `--list`. |
| `--endpoint <file>` | Read a specific endpoint descriptor instead of `$DSH_HOME/dsh-attach/endpoint.json`. |
| `--socket <path>` | Connect directly to this Unix socket or Windows named pipe. Requires `--token`. |
| `--token <token>` | Token for `--socket`. |
| `--profile <name>` | Only consider endpoints written by this profile. |
| `--theme <name>` | Palette: `light` (default) or `dark`. |
| `--log <file>` | Lifecycle log path. `off` disables it. |
| `--hot` | Development only: restart the TUI child when client/shared sources change. |
| `-h`, `--help` | Show help. |
| `-V`, `--version` | Print the client version. |

### Direct connection

Normally the client discovers descriptors under `$DSH_HOME/dsh-attach/` and
tries the newest endpoints in order. For a custom setup, point it at the
descriptor or at a socket and token directly:

```sh
dsh-attach --endpoint /path/to/endpoint.json
# Unix
dsh-attach --socket /path/to/attach.sock --token '<token>'
# Windows
# dsh-attach --socket \\.\pipe\dsh-attach-<pid> --token '<token>'
```

`--socket` without `--token` is not sufficient; the client falls back to normal
descriptor discovery in that case.

## Non-interactive listing

`--list` prints one row per top-level session with `ID`, `AGE`, `STATE`, `CWD`,
and `TITLE`:

```sh
dsh-attach --list
dsh-attach --list --all
```

Subagent sessions are excluded unless `--all` is supplied. The interactive
session picker also excludes subagent sessions; use `/subagents` inside the TUI to
browse the lineage of the current session.

## Upgrade

1. Install the new package into the same profile, either from the checkout or
   from a new tarball.
2. Restart DeepSeek Harness so the Host loads the new plugin build.
3. Restart any running `dsh-attach` client. The client and Host share protocol
   version 1; a descriptor written by an incompatible protocol is rejected with
   an explicit error.

The symlink does not need to be recreated when the profile path stays the same.


## Removal

Remove the `dsh-attach` bundle from the profile using your normal DSH plugin
workflow, delete the client symlink if you created one, and restart the Host.
Removing the package stops new sockets from being served. Descriptor files are
cleaned up on a normal Host shutdown; remove any stale leftovers from
`$DSH_HOME/dsh-attach/` only while no matching Host process is running.

## Next steps

- [Usage](usage.md) for prompts, approvals, questions, and subagents.
- [Keys and commands](keybindings.md) for the full reference.
- [Configuration](configuration.md) for routing and theme options.
