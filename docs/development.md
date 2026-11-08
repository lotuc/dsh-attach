# Development

## Architecture

The project has two halves that share a small wire protocol:

1. **Host plugin** (`lib/host.js`). Cordis injects `sessionController`; the
   plugin mounts `AttachServer` for the lifetime of the plugin fiber and stops it
   on disposal.
2. **Attach server** (`lib/host/server.js`). It creates the Unix socket and
   endpoint descriptors, authenticates clients, follows sessions through the
   real `sessionController`, and routes approvals and questions.
3. **Terminal client** (`lib/client/`). It discovers the descriptor, connects,
   sends requests, projects session frames into the pi-tui layout, and turns
   approvals and questions into modal panels.
4. **Shared protocol** (`lib/shared/protocol.js`). Constants and JSONL helpers
   used by both sides.

The important design constraint is that the bridge never starts a second
harness. It calls the live controller, so session policy, queueing, persistence,
approval semantics, and model selection stay in the Host.

### Session following

`session.open` calls `sessionController.follow()` with:

```js
{
  address: { kind: 'session', sessionId },
  assistantStream: true,
  maxMessages: 300
}
```

For a subagent history, the address becomes:

```js
{
  kind: 'subagent',
  parentSessionId,
  childSessionId,
  mode
}
```

The server pumps snapshots, events, and assistant-stream frames to the client.
Re-opening a session on the same connection replaces the previous follow stream;
closing the connection aborts the follow.

Older history uses the supported controller read API rather than starting a
second follow stream:

```js
sessionController.events({
  address,
  beforeSeq,          // exclusive: records with seq >= beforeSeq are not returned
  maxMessages: 300,   // the configured historyMessages budget
}, AbortSignal.timeout(30_000))
// => { cursor, records, hasMore }
```

`records` is a chronological page. The client uses the smallest sequence still
represented by a rendered row as the next `beforeSeq`; this also lets it refetch
rows dropped by transcript trimming. `events` is the supported name (older Host
builds expose the deprecated `page` alias). The Host advertises
`history.pagination` only when one of those methods exists.

The client projects a small set of user-visible events into transcript rows:
user messages, assistant messages, tool calls/results, turn/step state, titles,
model selection, permission and sandbox changes, todos, goals, retries, and
compaction. Unknown events are ignored rather than dumped into the transcript.

### Session lifecycle

Lifecycle routes call the same Host services the Web UI uses, so policy,
persistence, and running-work handling stay in the Host:

- `session.fork` calls `sessionController.fork({ sessionId, atSeq? })`. An
  omitted `atSeq` selects the latest completed turn; `allowMigration: false`
  preserves the controller's migration preflight.
- `session.archive` / `session.unarchive` call
  `workspaceController.archiveSession` / `unarchiveSession`. A plain archive
  refuses a Session with running work (`workspace/session-active`); passing
  `stopActivity: true` stops that work first.
- `session.pin` / `session.unpin` call `workspaceController.pinSession` /
  `unpinSession`.
- `session.presets` reads `agentPresets.remoteExportList()` (falling back to
  `list()`) for the new-session picker. The roster includes activation
  failures as `broken` instead of hiding them.

Each route is advertised in `host.describe` capabilities only when its Host
service is mounted. The client checks the capability before offering the
action, while older Hosts simply omit the route. DSH exposes no Session
deletion: sessions can be archived but never deleted, so `/session delete`
reports that limitation instead of inventing a destructive route.

The TUI surface is the existing `/session` group (`fork`, `archive`,
`unarchive`, `pin`, `unpin`, `presets`, `preset`, and `new --preset <id>`)
plus navigation-mode picker keys: `f` forks, `a` archives or restores, and `p`
pins or unpins the selected row.

### Interactive routing

The server registers `approval/request` and `user-questions/request` listeners
with `{ prepend: true }` so it sees requests before the default Web flow. Pending
interactions are held in memory, broadcast to every connection watching the
session, and replayed when another terminal opens the session later.

`approvals` and `questions` independently choose `tui`, `auto`, `web`, or `off`.
Grace timers keep a request with a watching terminal, and delegate it to the Web
flow only when no terminal connection owns it or after that terminal
disconnects. The first TUI answer settles the shared request and closes the
other TUI panels.

### Endpoint discovery

The Host writes two descriptors with mode `0600`:

- `$DSH_HOME/dsh-attach/endpoint.json`
- `$DSH_HOME/dsh-attach/<profile>-<pid>.json`

Writes are atomic (`write` to a temporary file, then `rename`). The client scans
`$DSH_HOME/dsh-attach/`. It tries the primary descriptor first and then
newest-first siblings, and filters by `--profile` when requested. A descriptor is accepted only when its `protocol` matches
`PROTOCOL_VERSION` and it contains both `socketPath` and `token`.

## Wire protocol

Transport is newline-delimited UTF-8 JSON over a Unix socket.

```text
client                                  host
  |  hello { token, client }              |
  |-------------------------------------->|
  |  welcome { protocol, host, config }   |
  |<--------------------------------------|
  |  request { id, method, params }       |
  |-------------------------------------->|
  |  response { id, ok, result|error }    |
  |<--------------------------------------|
  |  frame / approval / question / ...    |
  |<--------------------------------------|
```

Client notifications include:

- `frame`: a session snapshot, event, or assistant-stream chunk;
- `session.error`: the follow stream failed for a session;
- `approval` / `question`: an interactive request;
- `approval.closed` / `question.closed`: a request was answered or cancelled;
- `error`: an authentication or protocol error.

Server methods:

| Method | Purpose |
|---|---|
| `host.describe` | Host and config summary. |
| `session.list` | List sessions with summaries. |
| `session.open` / `session.close` | Follow or stop following a session. |
| `history.events` | Read one older page of the followed session's durable log (`beforeSeq` cursor). |
| `session.prompt` | Submit text with `queue` or `steer` mode. |
| `session.cancel` | Cancel the running turn. |
| `session.create` / `session.rename` | Create or rename sessions. `session.create` accepts an optional `agentPreset`. |
| `session.fork` | Fork a Session at its latest completed turn, or at an explicit `atSeq`; returns the child id. |
| `session.archive` / `session.unarchive` | Archive or restore a Session through the Workspace registry. `session.archive` accepts `stopActivity` to stop running work first. |
| `session.pin` / `session.unpin` | Pin or unpin a Session in Workspace navigation. |
| `session.presets` | Read the Host Agent-preset roster for new-session selection. Returns `{ supported: false, presets: [] }` when no preset registry is mounted. |
| `session.selectModel` | Switch provider/model (and optional reasoning effort). |
| `model.catalog` | Provider and model groups. |
| `commands.list` / `commands.execute` | Discover and execute Host slash commands. |
| `skill.list` / `skill.get` | User-invocable skill summaries and full instructions for `/skill` and `/name` completion. |
| `goal.get` | Read the live goal view including process-local `activation` (`armed`/`disarmed`). |
| `goal.complete` | Complete the current goal through `GoalService.complete`; advertised as the `goal.complete` capability. Other goal mutations use the Host command registry. |
| `workspace.list` | Workspace tree snapshot, with a `cwd` fallback on the client. |
| `subagent.summary` | Counts plus the active window (IDs, titles, and short catalog labels). Newer Hosts include labels; the client fills missing labels from `subagent.list`. |
| `subagent.children` | Fast direct-child catalog for `/subagent list`; falls back to recursive listing for small trees. Each row carries `parentActive`, `canContinue`, and `canInterrupt`, and the response advertises the Host's `control` capabilities. |
| `subagent.list` | Catalog descendants when the runtime supports it, including short labels. |
| `subagent.continue` | Deliver a human follow-up to one continuable child through `ctx.subagents.prompt` (falling back to `sendMessage`), addressed by the catalog's durable direct parent. |
| `subagent.interrupt` | Stop one running child's current turn through `interruptByParent` (falling back to `interrupt`), addressed by its durable direct parent; also accepts the currently followed subagent. |
| `approval.respond` / `approval.cancel` | Answer or cancel an approval. |
| `question.respond` / `question.cancel` | Answer or cancel a question batch. |
| `interactive.ack` | Acknowledge that this terminal actually displayed a shared request; unacknowledged panels do not block the grace handoff. |
| `interactive.detach` | Detach one terminal from a shared pending request. |
| `goal` notification | Process-local goal activation changed for the followed session. |
| `activity` | Heartbeat used by `auto` routing. |

Limits:

- protocol version `1`;
- inbound line cap 4 MiB, outbound line cap 64 MiB;
- unauthenticated `hello` deadline 10 seconds;
- session history snapshot capped at 300 messages;
- older-history pages use the same `historyMessages` message budget and a 25,000-row client paging ceiling;
- outbound writes wait for drain above a 4 MiB buffer;
- client requests default to a 180 second timeout (`attach/timeout`), which
  bounds a request left unanswered by a live but unresponsive Host.

When changing the wire format, update `PROTOCOL_VERSION` and both sides
together. A protocol mismatch is rejected during descriptor discovery.

## Source map

| Path | Role |
|---|---|
| `bin/dsh-attach.js` | Executable entry point; delegates to the client CLI. |
| `bin/herdr-preview.js` | Herdr plugin pane entrypoint; reconstructs the preview client invocation from pane env. |
| `lib/host.js` | Cordis plugin entry, injection, Config schema, and optional Host hot reload. |
| `lib/host/server.js` | Unix socket, authentication, JSONL protocol, follow pump, interactive routing, job bridge, descriptors. |
| `lib/host/subagents.js` | Pure subagent catalog row mapping and descendant counting. |
| `lib/host/subagent-control.js` | Runtime capability detection, catalog lookup, and per-row control flags. |
| `lib/host/shell-env.js` | Bounded `HERDR_*` env intake and shell-request merge for model commands. |
| `lib/host.d.ts` | Type declarations for the plugin entry. |
| `lib/client/cli.js` | Argument parsing, help, `--list`, theme validation, entry flow, `--hot`. |
| `lib/client/hot-reload.js` | Development supervisor that restarts the TUI child on source changes. |
| `lib/client/connection.js` | Descriptor discovery, socket connection/reconnect, request/response, notifications. |
| `lib/client/app.js` | TUI layout, event projection, commands, status, completion overlay, Herdr reports. |
| `lib/client/step-activity.js` | Turn/step lifecycle, tool grouping, and reasoning attachment. |
| `lib/client/clipboard-image.js` | Clipboard image intake for macOS, Linux and Windows. |
| `lib/client/interrupted-resume.js` | Interrupted-turn detection and idempotent continuation policy. |
| `lib/client/session-list.js` | Flat session rows with workspace metadata. |
| `lib/client/session-events.js` | Pure projection for state-only Session events. |
| `lib/client/session-snapshot.js` | Pure projection of snapshot metadata onto visible session state. |
| `lib/client/format.js` | Shared age and cwd formatting. |
| `lib/client/layout.js` | Left/right line fitting shared by the header, footer, preview and picker rows. |
| `lib/client/goal.js` | Goal projection normalization, `/goal` grammar, Host command mapping, and blocked/status labels. |
| `lib/client/plan.js` | `/plan` grammar, Host command mapping, and plan-mode status lines. |
| `lib/client/subagent-picker.js` | Ordered `/subagent list` rows from the lightweight catalog or session summaries, including control availability. |
| `lib/client/subagent-control.js` | Capability, availability, and error wording shared by the picker and `/subagent` commands. |
| `lib/client/autocomplete-layout.js` | Pure screen placement for the floating completion list. |
| `lib/client/editor.js` | Stable-height composer that renders completions as an overlay. |
| `lib/client/transcript.js` | Transcript row components, step groups, render cache, sanitization, long-stream behavior. |
| `lib/client/transcript-search.js` | Search over the loaded transcript with row/line offsets. |
| `lib/client/panels.js` | Approval, question, picker, job-output, and information panels. |
| `lib/client/approval-context.js` | Target, proposed-edit and session context for approval details. |
| `lib/client/notifications.js` | Unfocused-terminal bell policy for turns and interactions. |
| `lib/client/modals.js` | Named overlay registry shared by every modal panel. |
| `lib/client/picker-session.js` | Filterable picker setup and in-place row refresh. |
| `lib/client/scroll.js` | Shared key-to-offset mapping for read-only scroll panels. |
| `lib/client/command-catalog.js` | Local grouped commands, Host subcommand hints, and `/session`, `/job`, `/model` completion. |
| `lib/client/local-commands.js` | Local slash-command parsing and grouped dispatch. |
| `lib/client/model-picker.js` | Model rows, including reasoning-effort variants. |
| `lib/client/permission-presets.js` | Sandbox presets shared by completion and the picker. |
| `lib/client/keys.js` | Key constants, Ctrl/arrow matching, and mouse-wheel decoding. |
| `lib/client/herdr.js` | Herdr agent state, title/display-name metadata, and pane release. |
| `lib/client/herdr-preview.js` | Builds `plugin pane open` arguments and parses the opened pane ID. |
| `lib/client/inbox.js` | Normalizes the durable inbox projection and applies queue splices. |
| `lib/client/queue.js` | Formats pending messages and the read-only queue detail sections. |
| `lib/client/jobs.js` | Background-job roster ordering, durations, and durable event folding. |
| `lib/client/escape-cancel.js` | Double-Escape timing used to interrupt the running turn. |
| `lib/client/ctrl-c.js` | Idle-single vs active-double Ctrl+C exit policy. |
| `lib/client/peek.js` | Bounded subagent peek over an extra socket. |
| `lib/client/preview.js` | Read-only preview renderer for `--preview` panes. |
| `lib/client/log.js` | 0600 lifecycle log with rotation and token redaction. |
| `lib/client/theme.js` | Light and dark palettes and theme helpers. |
| `lib/client/subagent-labels.js` | Merges short catalog labels into active subagent rows. |
| `lib/shared/protocol.js` | Protocol version, limits, endpoint names, JSONL helpers. |
| `lib/shared/paths.js` | Shared `$DSH_HOME` resolution for the bridge and client. |
| `lib/shared/approval.js` | Localized approval-reason fallback shared by the bridge and panel. |
| `lib/shared/version.js` | Release version consumed by the bridge, CLI and client handshake. |
| `cordis.patch.yml` | Bundle patch that inserts the `dsh-attach` entry. |
| `herdr-plugin.toml` | Herdr plugin manifest with the `preview` pane entrypoint. |
| `test/*.test.mjs` | Node test runner suites. |

## Tests

Install dependencies and run the suite:

```sh
pnpm install
pnpm test
pnpm test:coverage
pnpm lint
pnpm check:syntax
pnpm check:docs
```

The suite uses Node's built-in test runner (`node --test test/*.test.mjs`) and
does not need a running Desktop or Web host. CI runs the suite and syntax check
on Node 22 and 24, with ESLint, syntax, docs, and coverage on Node 24. Integration tests start an
`AttachServer` with a fixture `sessionController` in a temporary `DSH_HOME` and
connect a real `AttachClient`.

Coverage includes:

- endpoint authentication, list/open/prompt, live frames;
- approval and question routing, including `tui` mode while a Web client is live;
- broadcasting to multiple terminals and replaying pending approvals to a late
  attach;
- subagent parent addresses, question cancellation, and Host command execution;
- subagent catalog labels and peek name fallback;
- subagent control routes (continue, interrupt, unsupported fallbacks), picker
  availability flags, command dispatch, and stop confirmations;
- approval details: full request/command content and scroll navigation;
- approval context: target, proposed edit and session metadata;
- interaction acknowledgement and notification policy;
- completion catalogs, grouped local subcommands, picker filtering, and metadata layout;
- `/goal` and `/plan` parsing, completion, status rendering, confirmation policy, and the Host `goal.complete` transition;
- model reasoning-effort rows and permission presets;
- pinned/archived session ordering;
- modal-slot lifecycle and picker row refresh;
- session snapshot projection and shared path/approval/version helpers;
- Host subagent traversal, row mapping, and catalog labels;
- Herdr env intake and shell-request merging;
- skill catalog routes, `/skill` grouping, and slash-name completion;
- shared scroll-key decoding for the read-only panels;
- shared left/right line fitting;
- loaded-transcript search and history truncation markers;
- editor completion splitting, dismissal callbacks, and focus cursor stripping;
- render caching, transcript ordering, and ANSI/OSC sanitization;
- Herdr state/title metadata arguments, release ordering, and lifecycle log redaction/rotation;
- Herdr managed preview pane arguments and pane ID parsing;
- Pending-inbox normalization, splice application and user-visible filtering;
- Step groups and lifecycle, flat session list formatting, subagent picker ordering, metadata event projection, goal normalization, local command dispatch, queue manager formatting and detail sections;
- App lifecycle (including slash autocomplete, queue manager, rejection handling, and listener cleanup), autocomplete screen placement, request timeouts, and release version consistency;
- Double-Escape interrupt timing and Ctrl+C exit policy;
- Background-job roster formatting, event folding, output polling, and bridge routes;
- Same-client reconnect against a restarted Host;
- client hot-reload supervisor lifecycle and Host module cache-busting;
- light/dark themes.

## Local development loop

The package is plain ESM with no build step.

```sh
# run the client from the checkout (after pnpm install)
node bin/dsh-attach.js --help

# pack and install into a profile
pnpm pack
dsh plugin --profile desktop add ./dsh-attach-2026.1108.2200.tgz
```

### Hot reload (development)

The package is copied into a profile, so normal edits in this checkout do not
affect an installed client or Host by themselves. Use a checkout-backed
install/symlink for live editing.

**Client:** `--hot` (or `DSH_ATTACH_HOT=1`) starts a small supervisor that
watches `bin/`, `lib/client/` and `lib/shared/`, restarts the TUI child on a
JavaScript change, and reopens the same `--session`/`--reattach` argument. The
Host and session keep running; the draft, pending images and scroll position
are not preserved across the restart.

```sh
node bin/dsh-attach.js --hot -s <session-id>
```

**Host:** enable `hotReload: true` in the profile patch, or start DSH with
`DSH_ATTACH_HOT=1`. The bridge watches `lib/host/server.js` and stops/restarts
itself through a cache-busted import; attached clients reconnect automatically.
Changes to `lib/host.js`, `lib/host/subagents.js`,
`lib/host/subagent-control.js` or `lib/shared/*` still need a DSH restart.
Enabling `hotReload` itself also needs one restart.

Useful environment variables during development:

```sh
DSH_ATTACH_PERF=1 dsh-attach -s <session-id>
DSH_ATTACH_KEYS=1 dsh-attach -s <session-id>   # raw key logging; may contain prompts
DSH_ATTACH_NO_MOUSE=1 dsh-attach               # isolate focus/mouse issues
DSH_ATTACH_HOT=1 dsh-attach -s <session-id>    # client hot supervisor
```

## Versioning and release checklist

Versions are time-based: `YYYY.MMDD.HHmm` using the local release time, for
example `2026.1108.2200`. Generate it with `date '+%Y.%m%d.%H%M'`. The value
must be kept in sync in:

- `package.json` (`version`, the release source of truth);
- `lib/shared/version.js` (`VERSION`, consumed by the Host bridge, CLI and
  client handshake);
- `herdr-plugin.toml` (Herdr plugin manifest `version`);
- the tarball and descriptor examples in `README.md` and `docs/`.

Release steps:

1. Run `pnpm test`.
2. Generate the time version and update `package.json`, `lib/shared/version.js`,
   the Herdr manifest and the tarball example together; `pnpm test` checks they
   agree.
3. If the wire format changed, bump `PROTOCOL_VERSION` in
   `lib/shared/protocol.js` and verify old/new compatibility behavior.
4. Run `pnpm pack`.
5. Install the tarball into a profile, restart the Host, and smoke-test attach,
   prompt, approval, question, and a subagent preview.
6. Relink the Herdr plugin when its manifest or wrapper changed:
   `herdr plugin link --enabled <path-to-dsh-attach>`.

## Host compatibility notes

| Host plugin | Behavior |
|---|---|
| 0.8.0+ | First version with in-memory pending approvals/questions, late-attach replay, and multi-terminal broadcast. |
| 0.10.0+ | Recommended baseline. Adds Host command execution and subagent history; the client warns when the Host is older. |
| 0.11.7+ | `subagent.summary` returns lightweight counts. |
| 0.13.0+ | `subagent.summary` includes active subagent IDs for the peek panel. |
| Newer Hosts | Advertise `subagent.continue` / `subagent.interrupt`; without those capabilities the TUI reports control unavailable and keeps browsing read-only. |
| Any | Without `workspaceController`, the picker groups by `cwd`; without `subagent.summary`, counts fall back to `session.list`. |

## License

MIT. See [LICENSE](../LICENSE).
