# Troubleshooting

## First checks

```sh
ls -l "${DSH_HOME:-$HOME/.dsh}/dsh-attach/"
tail -n 50 "${DSH_HOME:-$HOME/.dsh}/dsh-attach/client.log"
dsh-attach --list
```

Confirm:

- the plugin is installed in the running profile;
- Host and client use the same `DSH_HOME` and OS user;
- `endpoint.json` exists;
- `--list` can connect.

Inspect a descriptor without exposing the token:

```sh
jq '{pid, profile, socketPath, pluginVersion, protocol}' \
  "${DSH_HOME:-$HOME/.dsh}/dsh-attach/endpoint.json"
```

## Common problems

| Symptom | Fix |
|---|---|
| `no attach endpoint` | Install/mount the plugin, then reload DSH. |
| `cannot reach the attach bridge` | Stale/dead endpoint; try `/reconnect` or restart the Host. With `--socket`, restart the client because the token rotates. |
| `unknown attach method` | Host runs an older bridge; apply a recomposition/restart. |
| Host connection lost | Client retries and reopens; `/reconnect` forces it. |
| Approvals in Web instead of TUI | Set `approvals`/`questions` to `tui`; check grace periods. |
| TUI approval but Web popup remains | Late/old ownership; restart Host and dismiss the Web popup. |
| Question stays after `Esc` | Another client may answer it; use `s` to skip. |
| Composer unresponsive | Close panel with `Esc`; try `/quit`; test `DSH_ATTACH_NO_MOUSE=1`. |
| `Host plugin ... older than 0.10.0` | Reload the updated Host plugin. |
| Missing Host commands | Host route needs reload; local commands work. |
| Subagent history fails | Requires Host plugin 0.10.0+. |
| No sessions in picker | Blank sessions are hidden; use `--list --all`. |
| `command not found` | Add profile `.bin` to `PATH` or call the shim directly. |
| `Permission denied` | Same user and `DSH_HOME` required. |
| `needs a TTY` | Run from an interactive terminal; use `--list` for scripts. |
| Herdr resume cannot connect | Start the DSH Host first. |
| Herdr title not updated | Update Herdr and restart TUI; use `agent`/`pane` row source. |
| Preview pane closes | `DSH_ATTACH_PREVIEW_EXIT_AFTER` is positive; set `0` to keep open. |
| Jobs unavailable | Reload Host with job registry. |
| Preview needs Herdr | Run the parent TUI inside Herdr. |
| Preview plugin not linked | `herdr plugin link --enabled <path-to-dsh-attach>`. |
| Preview exits immediately | Ensure `node` is on `PATH`; relink after upgrade. |
| Continue says parent not live | Open/resume the direct parent first. |
| Continue says not continuable | One-shot/external child cannot continue. |
| Interrupt unavailable | Reload Host with subagent control routes. |
| Stop requested but child runs | Interrupt acknowledges cancellation; current step may finish. |
| Prompt history lost | History is per client run. |
| Stale endpoint files | Client skips unreachable endpoints; remove only when no Host is running. |

## Late attach

A terminal attaching while an approval/question is pending receives a replay on
Host plugin 0.8.0+. If Web already answered, no panel appears. Multiple TUIs
receive the request; the first answer wins.

## Focus and mouse

- Focus events are consumed; they must not act like `Esc`.
- `DSH_ATTACH_NO_MOUSE=1` disables mouse/focus reporting.
- `DSH_ATTACH_KEYS=1` logs raw keys, including prompt text; use temporarily.
- `Esc` on the initial picker does not exit. Use `Ctrl+C` twice or `/quit`.

See [Diagnostics](diagnostics.md).

## Windows

Bridge: `\\.\pipe\dsh-attach-<pid>`. Descriptor:
`%USERPROFILE%\.dsh\dsh-attach` (or `DSH_HOME`). Run Host and client as the same
user in Windows Terminal/ConPTY; WSL is not required.

Check:

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\dsh-attach"
dsh-attach --list
```

Herdr integration is Unix-only. Normal subagent control still works.
