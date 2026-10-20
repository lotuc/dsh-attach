# Troubleshooting

## First checks

1. Confirm that the Host plugin was installed into the profile that is actually
   running, and that DeepSeek Harness was restarted afterward.
2. Confirm that the client and Host use the same `DSH_HOME` and run as the same
   OS user.
3. Check the endpoint and the lifecycle log:

   ```sh
   ls -l "${DSH_HOME:-$HOME/.dsh}/tui-attach/"
   tail -n 50 "${DSH_HOME:-$HOME/.dsh}/tui-attach/client.log"
   ```

4. Test authentication and discovery without the TUI:

   ```sh
   dsh-attach --list
   ```

   A successful listing means the descriptor, socket, and token are usable.

You can inspect a descriptor without printing its token:

```sh
jq '{pid, profile, socketPath, pluginVersion, protocol}' \
  "${DSH_HOME:-$HOME/.dsh}/tui-attach/endpoint.json"
```

## Common problems

| Symptom | Cause and fix |
|---|---|
| `no attach endpoint under ...` | The plugin is not installed or not mounted, or the Host has not been restarted. Install the plugin, restart the Host, and confirm that `endpoint.json` appears. |
| `cannot reach the attach bridge (...)` | The descriptor points at an old or dead process. The client automatically tries other descriptors in the same directory. If all fail, restart the Host. |
| `unknown attach method: ...` | The running Host still has an older bridge build. Restart DeepSeek Harness to load the current plugin. |
| `Host connection closed. Press ctrl+c to exit.` | The Host restarted or the socket closed. The client does not reconnect and stays open with the error; press `Ctrl+C` and start `dsh-attach` again. |
| Approvals or questions appear in the Web GUI instead of the TUI | Check whether `approvals` / `questions` is `auto` or `web`, or whether the grace period expired before you answered. Set them to `tui` and restart the Host. |
| A question stays pending after `Esc` | `Esc` closes the TUI panel and releases the request from this client. Another client or the question timeout may still resolve it. Use `s` to skip the batch immediately. |
| Composer does not respond | Press `Esc` to close a leftover panel, or `Ctrl+C` and restart the client. If it only happens after focus changes, try `DSH_ATTACH_NO_MOUSE=1`. |
| `Host plugin ... is older than 0.10.0` | Restart the Host to load the newer bridge. Host command execution and subagent history require 0.10.0; pending approvals and questions are replayed from 0.8.0. |
| Host commands are missing from completion | The Host bridge needs one restart to expose `commands.list`. Local commands already work. |
| Subagent history cannot open | Opening subagent history requires Host plugin 0.10.0 or later. The subagent list and counts work on older Hosts. |
| No sessions in the picker | Blank sessions are hidden unless they are running or have subagents. Use `/sessions` after the Host creates a session, or `dsh-attach --list --all` to inspect the raw list. |
| `dsh-attach: command not found` | The symlink or `PATH` is missing. Use the profile's `node_modules/.bin/dsh-attach` path directly and recreate the symlink. |
| `Permission denied` on the socket | The client and Host are running as different users, or `DSH_HOME` differs. Run the client as the Host user with the same `DSH_HOME`. |
| `the interactive UI needs a TTY` | Start the client from an interactive terminal. Scripts should use `--list`. |
| `--preview needs a TTY` | Run the preview from an interactive terminal. |
| `--theme must be "light" or "dark"` | Use one of the two supported theme names. |
| Herdr resume cannot connect after restoring a pane | The resume command only restarts the TUI. Start the DSH Host first; the resume does not start it. |
| Herdr still shows `dsh-attach ...` instead of the session title | Update Herdr to 0.6.4 or later and restart the TUI. If your sidebar rows explicitly use `terminal_title`, switch them to `agent` or `pane`; metadata titles do not overwrite the terminal's OSC title. |
| `/jobs` reports background jobs are unavailable | Restart DeepSeek Harness after upgrading the plugin so the Host loads the job routes. The Host composition must also include its job registry (`dsh-jobs-local` / `dsh-tool-jobs`). |
| `/agents-preview` says it needs a Herdr pane | Run the parent `dsh-attach` inside Herdr, or use `/agents` for an in-TUI list. |
| `/agents-preview` reports the Herdr plugin is not linked | Run `herdr plugin link --enabled <path-to-dsh-tui-attach>`. Use the repository path or the installed profile package path. |
| `/agents-preview` opens a pane that exits immediately | Make sure `node` is on `PATH` and relink the plugin after upgrading this package. Check `herdr plugin log list --plugin dsh-tui-attach`. |
| Prompt history disappears after restart | Prompt history is per client run and is not persisted. |
| Old endpoint files remain after a Host restart | A shutdown normally removes its descriptor. A crashed Host may leave a stale descriptor; the client skips unreachable endpoints. Remove stale files only while no matching Host is running. |

## Approvals after a late attach

If a terminal attaches to a session while an approval or question is still
pending, the Host replays it, provided the Host has the in-memory pending
support (0.8.0 and later). If the Web GUI already answered the request, there
is nothing to replay and the panel will not appear.

If multiple TUI windows watch the same session, all receive the request. The
first answer wins, and the other panels close.

## Focus and mouse problems

- `focus {"state":"out"}` / `focus {"state":"in"}` in the log means the terminal
  is sending focus events. They are consumed by the viewport and should not act
  like `Esc`.
- `DSH_ATTACH_NO_MOUSE=1 dsh-attach ...` disables mouse and focus reporting. If
  the problem disappears, it is in that reporting path.
- `DSH_ATTACH_KEYS=1` logs raw keys, including possible prompt text. Use it only
  for temporary diagnosis.
- Compare the same session in tmux, in iTerm2 directly, and in a Herdr pane to
  identify which layer sends the problematic sequence.
- Pressing `Esc` on the initial picker no longer exits the client. Use `Ctrl+C`
  for an explicit exit.

See [Diagnostics](diagnostics.md) for log fields and performance instrumentation.

## Windows

The transport assumes Unix-domain sockets. Windows is not tested, and named-pipe
support is not implemented. Use WSL with a Linux Host, or run the client on the
same Unix-like machine as the Host.
