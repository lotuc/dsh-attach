# Development

## Architecture

1. **Host plugin** (`lib/host.js`) mounts `AttachServer` in the DSH process.
2. **Attach server** (`lib/host/server.js`) owns the Unix socket/named pipe,
   descriptor, auth, session following, approvals, and questions.
3. **Client** (`lib/client/`) follows frames, renders the TUI, and sends requests.
4. **Shared protocol** (`lib/shared/protocol.js`) defines JSONL messages and limits.

The bridge never starts a second harness; it calls the live Host controller, so
queueing, persistence, approvals, and model routing stay authoritative.

### Session follow

`session.open` calls `sessionController.follow()` with the session or subagent
address, `assistantStream: true`, and a message limit. The server pumps
snapshots/events/stream frames; reopening replaces the stream; closing aborts it.

Older history uses:

```js
sessionController.events({ address, beforeSeq, maxMessages }, timeout)
// => { cursor, records, hasMore }
```

`records` is chronological. The client uses the oldest rendered sequence as the
next cursor, so trimmed rows can be refetched. `events` is preferred; older
Hosts expose `page`.

### Lifecycle

- `session.fork` → `sessionController.fork`.
- `session.archive/unarchive`, `pin/unpin` → workspace controller.
- `session.presets` → Agent-preset registry (broken entries stay visible).
- Capabilities are advertised only when the service exists.
- DSH has no Session deletion; archive is the end state.

### Interactive routing

The bridge registers approval/question listeners before the Web flow. Requests
are held in memory, broadcast to watching terminals, and replayed on late
attach. `tui`/`auto`/`web`/`off` select ownership; grace timers only delegate
unacknowledged requests. First answer wins.

### Endpoint discovery

Descriptors with `0600`: `$DSH_HOME/dsh-attach/endpoint.json` and
`<profile>-<pid>.json`. Writes are atomic. The client tries the primary, then
newest siblings, filtered by `--profile`; protocol and token must match.

## Wire protocol

Newline-delimited UTF-8 JSON over Unix socket or Windows named pipe.

```text
hello { token, client }
welcome { protocol, host, config }
request { id, method, params }
response { id, ok, result|error }
frame / approval / question / ...
```

Client notifications: `frame`, `session.error`, `approval`, `question`,
`approval.closed`, `question.closed`, `error`.

| Method | Purpose |
|---|---|
| `host.describe` | Host/config summary. |
| `session.list` | Session summaries. |
| `session.open` / `close` | Follow/stop a session. |
| `history.events` | Older page by `beforeSeq`. |
| `session.prompt` / `cancel` | Prompt (`queue`/`steer`) or cancel. |
| `session.create` / `rename` | Create/rename; optional preset. |
| `session.fork` | Fork at latest turn or `atSeq`. |
| `session.archive` / `unarchive` / `pin` / `unpin` | Workspace lifecycle. |
| `session.presets` | Agent-preset roster. |
| `session.selectModel` / `model.catalog` | Model route. |
| `commands.list` / `execute` | Host slash commands. |
| `btw.ask` | Detached side question; no tools, no session write. |
| `skill.list` / `skill.get` | Skills. |
| `goal.get` / `goal.complete` | Goal view/completion. |
| `workspace.list` | Workspace tree or `cwd` fallback. |
| `subagent.summary` / `children` / `list` | Counts, direct children, descendants. |
| `subagent.continue` / `interrupt` | Follow-up or stop. |
| `approval.review` | Isolated LLM review of an approval. |
| `approval.suggest` | LLM-proposed auto-approval rule for the last approval. |
| `approval.respond` / `cancel` | Approval outcome. |
| `question.respond` / `cancel` | Question answers. |
| `interactive.ack` / `detach` | Shared-request acknowledgement/detach. |
| `activity` | Heartbeat for `auto`. |

Limits: protocol 1; inbound 4 MiB; outbound 64 MiB; hello deadline 10 s;
snapshot 300 messages; history same budget with 25k client ceiling; outbound
drain above 4 MiB; request timeout 180 s.

Changing the wire format requires a `PROTOCOL_VERSION` bump and both sides.

## Source map

| Path | Role |
|---|---|
| `bin/dsh-attach.js` | CLI entry. |
| `bin/herdr-preview.js` | Herdr preview entry. |
| `lib/host.js` | Plugin entry/config/hot reload. |
| `lib/host/server.js` | Transport, auth, protocol, follow, interactive/job routes. |
| `lib/host/btw.js` | Side-question route and bounded context. |
| `lib/host/approval-review.js` | Isolated approval reviewer prompt, JSON verdict, rule suggestion. |
| `lib/host/subagents.js` | Catalog mapping/counts. |
| `lib/host/subagent-control.js` | Control capability detection. |
| `lib/host/shell-env.js` | Bounded `HERDR_*` merge. |
| `lib/client/cli.js` | Args, help, `--list`, `--hot`. |
| `lib/client/hot-reload.js` | Client source supervisor. |
| `lib/client/connection.js` | Descriptor discovery, dial, reconnect, requests. |
| `lib/client/app.js` | TUI layout, events, commands, status. |
| `lib/client/panels.js` | Approval/question/picker/job/info/btw panels. |
| `lib/client/modals.js` | Named overlay registry. |
| `lib/client/editor.js` | Stable-height composer/completion. |
| `lib/client/transcript.js` | Rows, step groups, render cache, sanitization. |
| `lib/client/turn-fold.js` | Turn summary and hidden-row document. |
| `lib/client/live-activity.js` | Tool activity labels. |
| `lib/client/detail-level.js` | Compact/standard/verbose model. |
| `lib/client/command-catalog.js` / `local-commands.js` | Commands and completion. |
| `lib/client/history-pagination.js` | Older-history cursors/anchoring. |
| `lib/client/session-*.js` | Session rows/projections. |
| `lib/client/subagent-*.js` | Picker, labels, capability text. |
| `lib/client/{approval-context,queue,jobs,inbox,peek,preview,scroll,layout,format,theme,notifications,keys,escape-cancel,ctrl-c}.js` | Panel/support helpers. |
| `lib/client/herdr*.js` | Herdr reporting/preview args. |
| `lib/client/clipboard-image.js` | macOS/Linux/Windows clipboard. |
| `lib/client/log.js` | Rotating lifecycle log. |
| `lib/shared/protocol.js` | Wire constants/helpers. |
| `lib/shared/platform.js` | Socket/pipe, home expansion, signals. |
| `lib/shared/paths.js` | `$DSH_HOME` resolution. |
| `lib/shared/version.js` | Version. |
| `cordis.patch.yml` / `herdr-plugin.toml` | Bundle/plugin manifests. |

## Tests

```sh
pnpm install
pnpm test
pnpm test:coverage
pnpm lint
pnpm check:syntax
pnpm check:docs
```

Node's built-in runner; no running Host required. Integration tests start an
`AttachServer` with fixture controllers in a temporary `DSH_HOME`.

Coverage includes auth, session routes, frames, approvals/questions, late
attach, subagent control, goal/plan, completion, history paging, render/cache,
sanitization, Herdr, jobs, clipboard, platform helpers, reconnect, and
version consistency.

Coverage gates: 70% lines, 65% branches/functions.

## Local development

```sh
node bin/dsh-attach.js --help
pnpm pack
dsh plugin --profile desktop add ./dsh-attach-2026.1113.1141.tgz
```

Client `--hot` (or `DSH_ATTACH_HOT=1`) restarts the TUI on `bin/`,
`lib/client/`, or `lib/shared/` changes. Host `hotReload: true` (or
`DSH_ATTACH_HOT=1`) reloads `lib/host/server.js`; other Host modules need a DSH
restart. Enable `hotReload` once before using it.

Useful env: `DSH_ATTACH_PERF=1`, `DSH_ATTACH_KEYS=1`,
`DSH_ATTACH_NO_MOUSE=1`, `DSH_ATTACH_HOT=1`.

## Release

Version format: `YYYY.MMDD.HHmm` local time (`date '+%Y.%m%d.%H%M'`). Update:

- `package.json`
- `lib/shared/version.js`
- `herdr-plugin.toml`
- tarball/version examples in docs

Steps:

1. `pnpm test`
2. Bump all version files; tests check agreement.
3. Bump `PROTOCOL_VERSION` if the wire format changed.
4. `pnpm pack`
5. Install, reload/recompose DSH, smoke-test attach/prompt/approval/question/preview.
6. Relink Herdr if its manifest/wrapper changed.

## Host compatibility

| Host | Behavior |
|---|---|
| 0.8.0+ | Pending interaction replay/broadcast. |
| 0.10.0+ | Host commands and subagent history (recommended). |
| 0.11.7+ | Lightweight `subagent.summary`. |
| 0.13.0+ | Active subagent IDs for peek. |
| Newer | Subagent control capabilities. |
| Any | Missing workspace/preset/catalog services fall back or hide actions. |

## License

MIT. See [LICENSE](../LICENSE).
