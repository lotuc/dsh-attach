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

The client projects a small set of user-visible events into transcript rows:
user messages, assistant messages, tool calls/results, turn/step state, titles,
model selection, permission and sandbox changes, todos, goals, retries, and
compaction. Unknown events are ignored rather than dumped into the transcript.

### Interactive routing

The server registers `approval/request` and `user-questions/request` listeners
with `{ prepend: true }` so it sees requests before the default Web flow. Pending
interactions are held in memory, broadcast to every connection watching the
session, and replayed when another terminal opens the session later.

`approvals` and `questions` independently choose `tui`, `auto`, `web`, or `off`.
Grace timers delegate unanswered requests to the Web flow when it is live, or
release them back to the remaining Host listeners. The first answer from any
client settles the shared request and closes the other panels.

### Endpoint discovery

The Host writes two descriptors with mode `0600`:

- `$DSH_HOME/tui-attach/endpoint.json`
- `$DSH_HOME/tui-attach/<profile>-<pid>.json`

Writes are atomic (`write` to a temporary file, then `rename`). The client reads
all descriptors in the directory, tries the primary descriptor first and then
newest-first, and filters by `--profile` when requested. A descriptor is accepted
only when its `protocol` matches `PROTOCOL_VERSION` and it contains both
`socketPath` and `token`.

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
| `session.prompt` | Submit text with `queue` or `steer` mode. |
| `session.cancel` | Cancel the running turn. |
| `session.create` / `session.rename` | Create or rename sessions. |
| `session.selectModel` | Switch provider/model (and optional reasoning effort). |
| `model.catalog` | Provider and model groups. |
| `commands.list` / `commands.execute` | Discover and execute Host slash commands. |
| `workspace.list` | Workspace tree snapshot, with a `cwd` fallback on the client. |
| `subagent.summary` | Counts plus the active window (IDs, titles, and short catalog labels). Newer Hosts include labels; the client fills missing labels from `subagent.list`. |
| `subagent.list` | Catalog descendants when the runtime supports it, including short labels. |
| `approval.respond` / `approval.cancel` | Answer or cancel an approval. |
| `question.respond` / `question.cancel` | Answer or cancel a question batch. |
| `interactive.detach` | Detach one terminal from a shared pending request. |
| `activity` | Heartbeat used by `auto` routing. |

Limits:

- protocol version `1`;
- inbound line cap 4 MiB, outbound line cap 64 MiB;
- unauthenticated `hello` deadline 10 seconds;
- session history snapshot capped at 300 messages;
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
| `lib/host.js` | Cordis plugin entry, injection, and Config schema. |
| `lib/host/server.js` | Unix socket, authentication, JSONL protocol, follow pump, interactive routing, job bridge, descriptors. |
| `lib/host.d.ts` | Type declarations for the plugin entry. |
| `lib/client/cli.js` | Argument parsing, help, `--list`, theme validation, entry flow. |
| `lib/client/connection.js` | Descriptor discovery, socket connection/reconnect, request/response, notifications. |
| `lib/client/app.js` | TUI layout, event projection, commands, status, completion overlay, Herdr reports. |
| `lib/client/step-activity.js` | Turn/step lifecycle, tool grouping, and reasoning attachment. |
| `lib/client/session-tree.js` | Workspace/cwd session tree, labels, and descriptions. |
| `lib/client/format.js` | Shared age and cwd formatting. |
| `lib/client/autocomplete-layout.js` | Pure screen placement for the floating completion list. |
| `lib/client/editor.js` | Stable-height composer that renders completions as an overlay. |
| `lib/client/transcript.js` | Transcript row components, step groups, render cache, sanitization, long-stream behavior. |
| `lib/client/panels.js` | Approval, question, picker, job-output, and information panels. |
| `lib/client/command-catalog.js` | Local slash commands and `/resume` / `/model` completion. |
| `lib/client/keys.js` | Key constants and Ctrl/arrow matching across terminal encodings. |
| `lib/client/herdr.js` | Herdr agent state, title/display-name metadata, and pane release. |
| `lib/client/herdr-preview.js` | Builds `plugin pane open` arguments and parses the opened pane ID. |
| `lib/client/inbox.js` | Normalizes the durable inbox projection and applies queue splices. |
| `lib/client/queue.js` | Formats pending messages and the read-only queue detail sections. |
| `lib/client/jobs.js` | Background-job roster ordering, durations, and durable event folding. |
| `lib/client/escape-cancel.js` | Double-Escape timing used to interrupt the running turn. |
| `lib/client/peek.js` | Bounded subagent peek over an extra socket. |
| `lib/client/preview.js` | Read-only preview renderer for `--preview` panes. |
| `lib/client/log.js` | 0600 lifecycle log with rotation and token redaction. |
| `lib/client/theme.js` | Light and dark palettes and theme helpers. |
| `lib/client/subagent-order.js` | Stable tree ordering for subagent rows. |
| `lib/client/subagent-labels.js` | Merges short catalog labels into active subagent rows. |
| `lib/shared/protocol.js` | Protocol version, limits, endpoint names, JSONL helpers. |
| `cordis.patch.yml` | Bundle patch that inserts the `tui-attach` entry. |
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
- approval details: full request/command content and scroll navigation;
- completion catalogs, picker filtering, and metadata layout;
- editor completion splitting, dismissal callbacks, and focus cursor stripping;
- render caching, transcript ordering, and ANSI/OSC sanitization;
- Herdr state/title metadata arguments, release ordering, and lifecycle log redaction/rotation;
- Herdr managed preview pane arguments and pane ID parsing;
- Pending-inbox normalization, splice application and user-visible filtering;
- Step groups and lifecycle, session tree grouping and formatting, queue manager formatting and detail sections;
- App lifecycle (including slash autocomplete, queue manager, rejection handling, and listener cleanup), autocomplete screen placement, request timeouts, and release version consistency;
- Double-Escape interrupt timing;
- Background-job roster formatting, event folding, output polling, and bridge routes;
- Same-client reconnect against a restarted Host;
- light/dark themes.

## Local development loop

The package is plain ESM with no build step.

```sh
# run the client from the checkout (after pnpm install)
node bin/dsh-attach.js --help

# pack and install into a profile
pnpm pack
dsh plugin --profile desktop add ./dsh-tui-attach-0.14.0.tgz
```

Restart DeepSeek Harness after changing anything under `lib/host/` or the bundle
patch. Client-only changes take effect the next time `dsh-attach` starts.

Useful environment variables during development:

```sh
DSH_ATTACH_PERF=1 dsh-attach -s <session-id>
DSH_ATTACH_KEYS=1 dsh-attach -s <session-id>   # raw key logging; may contain prompts
DSH_ATTACH_NO_MOUSE=1 dsh-attach               # isolate focus/mouse issues
```

## Versioning and release checklist

The version appears in several places and must be kept in sync:

- `package.json` (`version`);
- `lib/host/server.js` (`PLUGIN_VERSION`);
- `lib/client/cli.js` (`--version` output);
- `lib/client/connection.js` (client `hello` payload);
- `herdr-plugin.toml` (Herdr plugin manifest `version`);
- the tarball and descriptor examples in `README.md` and `docs/`.

Release steps:

1. Run `pnpm test`.
2. Update all version strings and the tarball example.
3. If the wire format changed, bump `PROTOCOL_VERSION` in
   `lib/shared/protocol.js` and verify old/new compatibility behavior.
4. Run `pnpm pack`.
5. Install the tarball into a profile, restart the Host, and smoke-test attach,
   prompt, approval, question, and a subagent preview.
6. Relink the Herdr plugin when its manifest or wrapper changed:
   `herdr plugin link --enabled <path-to-dsh-tui-attach>`.

## Host compatibility notes

| Host plugin | Behavior |
|---|---|
| 0.8.0+ | First version with in-memory pending approvals/questions, late-attach replay, and multi-terminal broadcast. |
| 0.10.0+ | Recommended baseline. Adds Host command execution and subagent history; the client warns when the Host is older. |
| 0.11.7+ | `subagent.summary` returns lightweight counts. |
| 0.13.0+ | `subagent.summary` includes active subagent IDs for the peek panel. |
| Any | Without `workspaceController`, the picker groups by `cwd`; without `subagent.summary`, counts fall back to `session.list`. |

## License

MIT. See [LICENSE](../LICENSE).
