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
- Pane title/display-name metadata needs Herdr 0.6.4 or later; this package's
  plugin manifest already requires 0.9.0.
- `dsh-attach` must be on `PATH`; the resume command begins with a plain command
  name.
- Resume restarts only the TUI client. The DSH Host must still be running. When
  Herdr restores a pane after a machine reboot, the resume fails if the Host has
  not started yet.
- The client reads `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_BIN_PATH` from the
  pane environment. Outside a Herdr pane all reporting is a no-op.

## Herdr environment in model commands

The Host runs outside the Herdr pane, so model `bash` commands do not inherit
`HERDR_ENV` and the pane ids by default. When `dsh-attach` opens a session
inside Herdr, it sends the current `HERDR_*` variables with `session.open`; the
Host bridge scopes them to that followed session and merges them into the
ordinary `env` of each shell request.

This makes patterns such as `herdr pane ...` in model-run commands see the same
pane context as the terminal client:

```text
HERDR_ENV=1
HERDR_PANE_ID=...
HERDR_BIN_PATH=...
HERDR_SOCKET_PATH=...
HERDR_WORKSPACE_ID=...
```

Only names matching `HERDR_[A-Z0-9_]+` are accepted; values are capped, and
`PATH` or other arbitrary variables are intentionally not forwarded. If several
terminals follow the same session, the most recently opened connection's Herdr
facts win. This is a local same-user bridge: shell commands can see these pane
identities, so do not place secrets in custom `HERDR_*` variables.

## Pane titles

When a Session has a title, the client reports it as both the pane `title` and
the visible `display_agent` through `herdr pane report-metadata`. Herdr's pane
navigator and the default Agent sidebar rows then show the session name instead
of the launch command (`dsh-attach ...`) or the generic `dsh` label. Title
changes are reported as they arrive; quitting clears the metadata before
releasing the pane.

The default sidebar `agent` row uses `display_agent`; the pane navigator prefers
`title`. Custom sidebar rows that explicitly use `terminal_title` or
`terminal_title_stripped` read the terminal's OSC title instead and are not
changed by metadata.

## Subagent peek

The compact subagent peek described in [Usage](usage.md#subagent-peek) is
enabled by default in any terminal, including Herdr. `/peek` toggles it. It uses
one extra Unix socket per peek, not a new process, and keeps at most two peeks.

## Managed preview pane setup

`/subagents-preview` opens **Herdr plugin panes**, not shell panes. Link this
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

If the plugin is not linked, `/subagents-preview` reports the link command instead
of silently falling back to a shell pane.

## Multi-pane subagent previews

From a parent `dsh-attach` running inside a Herdr pane:

```text
/subagents-preview        # open up to two running subagents
/subagents-preview 1      # open one
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
- outside Herdr, `/subagents-preview` reports that `/subagents` should be used
  instead.

### Automatic close

Plugin panes run their manifest command directly, without a shell. When the
preview process exits, Herdr closes the pane automatically.

By default the preview process stays open until you press `Ctrl+C`/`q` (or
close the pane). Auto-close is opt-in: set `DSH_ATTACH_PREVIEW_EXIT_AFTER` to
the number of idle seconds before the preview exits. For example:

```sh
DSH_ATTACH_PREVIEW_EXIT_AFTER=15 dsh-attach
```

A new turn, approval request, assistant stream, or user message cancels the
pending close. The default is **`0`**, which keeps the pane open. When enabled,
the preview footer shows the remaining auto-close time; a lost Host connection
also closes after a short grace period.

## Standalone preview mode

`--preview` can be used without `/subagents-preview`:

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
| `/subagents-preview [count]` | Open managed plugin panes for 1–2 running subagents. |
| `/subagents` | List the subagent lineage inside the TUI. |
| `/peek` | Toggle the bottom subagent peek. |
| `/parent` | Return from a subagent history to its parent. |
