# Herdr integration

Run `dsh-attach` directly inside a [Herdr](https://herdr.dev/) pane. No
integration install step or Herdr configuration is required.

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

- The first split targets the current pane: to the right when the pane is wide
  (`width >= max(160, height * 3)`), otherwise downward.
- Later splits target the previous preview pane and alternate direction.
- Splits use `--no-focus`, so the parent TUI keeps focus.
- Each pane runs `dsh-attach --preview <child-id> --parent <parent-id>`, plus
  the parent's `--profile`, `--endpoint`, and dark-theme options.

A preview pane is a separate lightweight renderer:

- no editor, command completion, approval UI, polling, or Herdr agent reporting;
- read-only view of the child session's recent output;
- `PgUp`/`PgDn` scroll, `End` jumps to the newest output, and `Ctrl+C` or `q`
  closes the pane;
- panes do not close automatically; closing one does not stop or affect the
  subagent;
- outside Herdr, `/agents-preview` reports that `/agents` should be used
  instead.

## Standalone preview mode

`--preview` can be used without `/agents-preview`:

```sh
dsh-attach --preview <child-session-id> --parent <parent-session-id>
```

`--parent` gives the preview its durable parent context for a subagent session.
The preview still requires a TTY and cannot open approvals or questions.

## Herdr command summary

| Command | Purpose |
|---|---|
| `/agents-preview [count]` | Split Herdr panes for 1–2 running subagents. |
| `/agents` | List the subagent lineage inside the TUI. |
| `/peek` | Toggle the bottom subagent peek. |
| `/parent` | Return from a subagent history to its parent. |
