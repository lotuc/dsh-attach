# Herdr integration

Run `dsh-attach` directly inside a [Herdr](https://herdr.dev/) pane. Agent
status reporting needs no Herdr configuration. Managed subagent preview panes
need a one-time Herdr plugin link.

## Agent status reporting

Inside a Herdr pane, the client reports a `dsh` agent with source
`dsh-tui-attach` and one of three states:

| State | Meaning |
|---|---|
| `idle` | The parent turn and all subagents are idle; the client can accept input. |
| `working` | A turn is running, **or** any subagent is still running at any depth, even if the parent turn has already finished. |
| `blocked` | An approval or question panel is waiting for an answer. |

A `blocked` report includes a short message such as `bash approval: ...` or a
question summary. Herdr's `herdr agent wait` can wait on that state.

The client also:

- reports a resume command: `dsh-attach --reattach <session-id>`, preserving the
  original `--profile`, `--endpoint`, and `--theme dark` options;
- refreshes the resume command when the session changes;
- suppresses duplicate state and message reports;
- releases the pane when the TUI exits, so no ghost agent is left behind.

### Requirements

- Herdr 0.9.2 or later uses the reported resume command. Earlier versions only
  use the state reports.
- `dsh-attach` must be on `PATH`; the resume command begins with a plain command
  name.
- Resume restarts only the TUI client. The DSH Host must still be running. When
  Herdr restores a pane after a machine reboot, the resume fails if the Host has
  not started yet.
- The client reads `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_BIN_PATH` from the
  pane environment. Outside a Herdr pane all reporting is a no-op.

## Subagent peek

The compact subagent peek described in [Usage](usage.md#subagent-peek) is
enabled by default in any terminal, including Herdr. `/peek` toggles it. It uses
one extra Unix socket per peek, not a new process, and keeps at most two peeks.

## Managed preview pane setup

`/agents-preview` opens **Herdr plugin panes**, not shell panes. Link this
repository, or its installed copy in the DSH profile, once:

```sh
herdr plugin link --enabled /path/to/dsh-tui-attach
# or, when installed in the desktop profile:
herdr plugin link --enabled ~/.dsh/profiles/desktop/node_modules/dsh-tui-attach
```

The plugin manifest is [herdr-plugin.toml](../herdr-plugin.toml). It defines the
`preview` entrypoint, which runs `node bin/herdr-preview.js`. Requirements:

- Herdr 0.9.0 or later;
- `node` on `PATH` (Node.js `^22.19.0 || >=24.0.0`);
- an up-to-date linked path after upgrading this package. Linked local plugins
  are not updated by `herdr plugin update`; run `herdr plugin link` again (or
  unlink and relink) after changing the checkout.

If the plugin is not linked, `/agents-preview` reports the link command instead
of silently falling back to a shell pane.

## Multi-pane subagent previews

From a parent `dsh-attach` running inside a Herdr pane:

```text
/agents-preview        # open up to two running subagents
/agents-preview 1      # open one
```

The count is clamped to 1–2. Only **running** subagents in the current session's
lineage are opened, and each invocation opens new panes rather than reusing
existing preview panes.

Split behavior:

- The first pane targets the current pane: to the right when the pane is wide
  (`width >= max(160, height * 3)`), otherwise downward.
- Later panes target the previous preview pane and alternate direction.
- Panes open with `--no-focus`, so the parent TUI keeps focus.
- Each plugin pane receives the child and parent session IDs, `--profile`,
  `--endpoint`, and the theme through `--env`; the wrapper reconstructs the
  matching `dsh-attach --preview` invocation.

A preview pane is a separate lightweight renderer:

- no editor, command completion, approval UI, polling, or Herdr agent reporting;
- read-only view of the child session's recent output;
- `PgUp`/`PgDn` scroll, `End` jumps to the newest output, and `Ctrl+C` or `q`
  closes the pane;
- closing one does not stop or affect the subagent;
- outside Herdr, `/agents-preview` reports that `/agents` should be used
  instead.

### Automatic close

Plugin panes run their manifest command directly, without a shell. When the
preview process exits, Herdr closes the pane automatically.

The preview process exits after the child has been idle for
`DSH_ATTACH_PREVIEW_EXIT_AFTER` seconds. The default is **15 seconds**. A new
turn, approval request, assistant stream, or user message cancels the pending
close. Set the variable to `0` to keep preview panes open until you press
`Ctrl+C`/`q`:

```sh
DSH_ATTACH_PREVIEW_EXIT_AFTER=0 dsh-attach
```

The preview footer shows the remaining auto-close time. If the Host connection
is lost, the preview closes after a short grace period so the managed pane does
not linger.

## Standalone preview mode

`--preview` can be used without `/agents-preview`:

```sh
dsh-attach --preview <child-session-id> --parent <parent-session-id>
```

`--parent` gives the preview its durable parent context for a subagent session.
The preview still requires a TTY and cannot open approvals or questions. By
default standalone previews stay open; add `--preview-exit-after <seconds>` to
exit after that much idle time. The plugin wrapper passes
`DSH_ATTACH_PREVIEW_EXIT_AFTER` to this option automatically.

## Herdr command summary

| Command | Purpose |
|---|---|
| `/agents-preview [count]` | Open managed plugin panes for 1–2 running subagents. |
| `/agents` | List the subagent lineage inside the TUI. |
| `/peek` | Toggle the bottom subagent peek. |
| `/parent` | Return from a subagent history to its parent. |
