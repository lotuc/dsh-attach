# Herdr integration

Run `dsh-attach` inside a [Herdr](https://herdr.dev/) pane. Status reporting
works automatically; managed subagent previews need a one-time plugin link.
Herdr integration is Unix-only.

## Agent status

| State | Meaning |
|---|---|
| `idle` | Parent turn and all subagents idle. |
| `working` | A turn or any descendant subagent is running. |
| `blocked` | An approval or question awaits an answer. |

`blocked` carries a short reason. `herdr agent wait` can wait for these states.
The client also reports the resume command
`dsh-attach --reattach <session-id>` (preserving profile/endpoint/theme),
refreshes it on session change, and releases the agent on exit.

Requirements:

- Herdr 0.9.2+ for resume; 0.6.4+ for title metadata.
- `dsh-attach` on `PATH`.
- DSH Host still running; resume only restarts the client.
- Env: `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`.

## Model shell environment

The Host runs outside Herdr. On `session.open`, the client forwards current
`HERDR_*` facts; the bridge scopes them to that session and merges them into
model shell requests. Only `HERDR_[A-Z0-9_]+` names are accepted, bounded in
count/size. The latest connection wins if multiple terminals follow a session.
Do not store secrets in `HERDR_*`.

## Pane titles

Session title is reported as Herdr `title` and `display_agent`, so navigator and
Agent sidebar rows show the session name. Default `agent` rows use
`display_agent`; custom rows using `terminal_title` are unaffected.

## Subagent peek

`/peek` toggles the compact subagent peek. It uses one extra bridge connection
per peek, not a process.

## Managed preview panes

Link the package once:

```sh
herdr plugin link --enabled /path/to/dsh-attach
# desktop profile:
herdr plugin link --enabled ~/.dsh/profiles/desktop/node_modules/dsh-attach
```

Requires Herdr 0.9.0+, Node.js `^22.19.0 || >=24.0.0`, and relinking after
upgrading a local checkout.

```text
/subagents-preview        # up to two running subagents
/subagents-preview 1      # one
```

Only running subagents in the current lineage are opened. Panes are read-only,
open without focus, and do not stop the child. `PgUp`/`PgDn` scroll,
`End` follows, `Ctrl+C`/`q` closes.

First pane splits right if
`width >= max(160, height * 3)`, else down; later panes target the previous
preview. Each pane receives child/parent IDs, profile, endpoint, and theme.

### Auto-close

Plugin panes close when the preview process exits. Default is to stay open.
Set an idle timeout:

```sh
DSH_ATTACH_PREVIEW_EXIT_AFTER=15 dsh-attach
```

New output/approval/message cancels the timer; `0` disables it. The footer shows
remaining time. A lost Host closes after a short grace.

## Standalone preview

```sh
dsh-attach --preview <child-id> --parent <parent-id>
```

Requires a TTY; no approval/question UI. Stays open unless
`--preview-exit-after <seconds>` is set.

## Commands

| Command | Purpose |
|---|---|
| `/subagents-preview [count]` | Open 1–2 managed preview panes. |
| `/subagents` | List lineage in the TUI. |
| `/peek` | Toggle subagent peek. |
| `/parent` | Return to the parent session. |
