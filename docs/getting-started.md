# Getting started

## Requirements

- DSH Desktop or Web with `sessionController`; the client can start it.
- Same OS user as the Host.
- Node.js `^22.19.0 || >=24.0.0` for the client.
- Unix socket on Linux/macOS; named pipe on Windows. Windows TUI needs a
  ConPTY terminal such as Windows Terminal.
- For remote attach, an OpenSSH client on the local machine and `dsh-attach`
  installed in the remote profile. Both ends need Node.js.

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
dsh-attach --list --json    # machine-readable session summaries
dsh-attach --models         # available provider/model entries
dsh-attach --models --json  # full model catalog for a dispatcher
dsh-attach --exec -p "run the tests"   # one-shot, no TUI
dsh-attach --exec --jsonl -p "run the tests"   # stream progress events
dsh-attach --ssh user@host                    # attach to a remote Host
dsh-attach --ssh host --exec -p "run the tests"   # remote one-shot
dsh-attach --remote win                       # use a configured remote alias
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
| `-f`, `--prompt-file <path>` | With `--exec`, read the prompt from a UTF-8 file instead of `--prompt`/stdin. |
| `-o`, `--output <path>` | With `--exec`, also write the final text to this file. |
| `-C`, `--cwd <path>` | Working directory for a new session. |
| `--cache-root <path\|@cwd\|@session>` | Keep language-tool caches under this directory (off by default); `@cwd` uses the launching directory, `@session` the Session workspace. |
| `--list` | Print sessions and exit. |
| `--all` | Include subagent sessions in `--list`. |
| `--models` | Print the Host's available `provider/model` entries and exit; mutually exclusive with `--exec`, `--list`, preview, `--hot`, and `--stdio-proxy`. |
| `--exec` | Run one prompt without a TUI and print the final answer; reads stdin when `--prompt` and `--prompt-file` are omitted. |
| `--json` | With `--exec`, print one JSON result object; with `--list`, print one JSON object of full session summaries; with `--models`, print the model catalog. |
| `--jsonl` | With `--exec`, stream newline-delimited progress events (`session.started`, `text.delta`, `reasoning.delta`, `tool.call`, `tool.result`, `interaction`, `turn.end`, `error`). |
| `--approvals <deny\|host>` | With `--exec`, reject approvals (default) or delegate them to DSH Web. |
| `--approval-rules <file\|@default>` | With `--exec`, load scoped rules (TOML/JSONC); `@default` reads the TUI's auto-approve policy. |
| `--approve` | With `--exec`, allow every approval (dangerous). |
| `--exec-timeout <seconds>` | Cancel a stalled exec; default 1800, `0` waits forever. |
| `--allow-dir <path>` | With `--exec`, register a writable root; repeatable, `~` expanded. |
| `--permission <preset>` | With `--exec`, apply `read-only`, `workspace-write`, `danger-full-access`, or `auto` before the prompt. |
| `--model <provider/model>` | With `--exec`, select the provider/model before the prompt. |
| `--preset <id>` | With `--exec`, create the new Session with this agent preset; incompatible with `--session`. |
| `--title <text>` | With `--exec`, rename the Session before the prompt. |
| `--endpoint <file>` | Use a specific endpoint descriptor. |
| `--socket <path>` | Connect to a socket or named pipe; needs `--token`. |
| `--token <token>` | Token for `--socket`. |
| `--profile <name>` | Filter descriptors by profile. |
| `--ssh <target>` | Attach over SSH (`user@host` or an `~/.ssh/config` alias); no remote TCP listener. A configured remote alias name is expanded transparently. |
| `--remote <alias>` | Attach using a named remote alias from `$DSH_HOME/dsh-attach/remotes.toml`. |
| `--remote-bin <path>` | Explicit remote `dsh-attach` executable (requires `--ssh` or `--remote`). |
| `--ssh-opt <arg>` | Extra argument passed to `ssh`; repeatable (requires `--ssh` or `--remote`). |
| `--stdio-proxy` | Remote-only stdin/stdout proxy used by `--ssh`; not for direct use. |
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

## Remote SSH

`--ssh` runs `ssh -T` with keepalives and starts `dsh-attach --stdio-proxy` on
the remote host. The proxy discovers the remote `$DSH_HOME/dsh-attach/endpoint.json`,
dials the Unix socket or Windows named pipe, injects the descriptor token into
the opening `hello`, and pipes NDJSON frames in both directions:

```sh
dsh-attach --ssh user@host
dsh-attach --ssh build-box --profile desktop -s <session-id>
dsh-attach --ssh build-box --remote-bin ~/.local/bin/dsh-attach --list
dsh-attach --ssh build-box --exec --jsonl -p "run the tests"
dsh-attach --ssh build-box --ssh-opt "-o" --ssh-opt "StrictHostKeyChecking=accept-new"
```

- The local client never starts a Host in SSH mode. If the remote Host is not
  running, the proxy reports `no attach endpoint`.
- `--exec` and `--list` add `BatchMode=yes`, so a password prompt fails fast
  instead of hanging a script; configure key/agent auth for those modes.
- `--cwd`, `--allow-dir`, `--endpoint`, and `--cache-root` name **remote**
  paths. They are not expanded with the local home or cwd. `--cache-root @cwd`
  is rejected; use `@session` or an explicit remote path.
- The remote `dsh-attach` is located on `PATH`, at `$HOME/.local/bin/dsh-attach`,
  or under `$HOME/.dsh/profiles/*/node_modules/.bin/dsh-attach`. Pass
  `--remote-bin` to skip the probe (for a Windows remote, pass the `.cmd` path).
- `--ssh` cannot be combined with `--socket` or `--hot`. `--remote-bin` and
  `--ssh-opt` require `--ssh` or `--remote`.
- The TUI header shows `ssh:<target>` (or `ssh:<alias>` for a remote alias);
  `/desktop` is disabled because it would focus the local desktop, and local
  `HERDR_*` variables are not forwarded.

### Remote aliases

Store frequently used remote hosts in `$DSH_HOME/dsh-attach/remotes.toml`
(`~/.dsh/dsh-attach/remotes.toml` by default) and connect with a short name:

```sh
dsh-attach remote add win --ssh user@localhost \
  --ssh-opt -p2233 \
  --remote-bin "C:/Users/me/AppData/Roaming/npm/dsh-attach.cmd" \
  --profile desktop
dsh-attach remote list
dsh-attach remote show win
dsh-attach --remote win -s <session-id>
dsh-attach --ssh win -s <session-id>      # transparent alias lookup
```

```toml
[remotes.win]
ssh = "user@localhost"
ssh_opts = ["-p2233"]
remote_bin = "C:/Users/me/AppData/Roaming/npm/dsh-attach.cmd"
profile = "desktop"
# endpoint = "/remote/endpoint.json"
# cache_root = "@session"
```

- `dsh-attach remote add <name> --ssh <target>` validates the name and refuses
  to replace an existing alias without `--force`. `--cache-root @cwd` is
  rejected because the working directory is remote.
- `remote list [--json]`, `remote show <name> [--json]`, and
  `remote remove <name>` (alias `rm`) inspect or edit the file.
- `--remote <alias>` is mutually exclusive with `--ssh`, `--socket`, `--hot`,
  and `--stdio-proxy`. CLI flags for `--profile`, `--remote-bin`,
  `--endpoint`, and `--cache-root` override alias fields; repeated `--ssh-opt`
  values are appended to the alias options.
- Override the file location with `DSH_ATTACH_REMOTES`. The header and reattach
  hint show the concise alias name.

## Listing

`--list` prints `ID`, `AGE`, `STATE`, `CWD`, and `TITLE`. Subagent sessions are
hidden unless `--all` is used. The interactive picker also hides subagents; use
`/subagent list` inside a session.

`--list --json` prints one `{"items":[...]}` object for scripts. It applies the
same `--all` filter and newest-first order, but keeps full `sessionId`, `cwd`,
`title`, `agentPreset`, and `model` values instead of truncating columns.

```sh
dsh-attach --list --json
dsh-attach --list --json --all
```

## Models

`--models` queries the Host's `model.catalog` and prints one `provider/model`
entry per line for use with `--model`. Add `--json` for the complete catalog
(defaults, routable providers, groups, and reasoning efforts). Both forms work
over `--ssh`/`--remote`.

```sh
dsh-attach --models
dsh-attach --models --json
dsh-attach --ssh build-box --models
```

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
