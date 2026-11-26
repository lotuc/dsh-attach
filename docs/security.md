# Security

`dsh-attach` is a control surface for one Harness. Locally it speaks over an
owner-only socket or named pipe; remotely it can relay that same local protocol
over an SSH stdio channel. It adds no listener and no second authorization
layer either way.

## Trust boundary

The client runs as the **same OS user** as the Host. Connecting grants the same
session, prompt, model, approval, and subagent permissions as that user.
Anyone who can connect can operate the Harness. Protect the account, the
`$DSH_HOME` directory, and the endpoint token.

## Transport

- Unix socket on Linux/macOS; Windows named pipe
  (`\\.\pipe\dsh-attach-<pid>`). No TCP listener.
- Default Unix socket: `$DSH_HOME/dsh-attach/attach-<pid>.sock`, with a temp
  fallback when the path is too long.
- Unix directory `0700`; socket/descriptor `0600`.
- Windows: directory ACLs plus the random token; no Unix mode claim.
- Descriptor: `endpoint.json` and `<profile>-<pid>.json`.
- Remote attach: `ssh -T <target> dsh-attach --stdio-proxy`. SSH carries
  NDJSON frames on stdin/stdout; no TCP port is opened on the Host, and no
  `ssh -L`/`-R` forward is required.

## Authentication

Each Host generates a 32-byte random token, stores it in the descriptor, and
compares a SHA-256 hash with `timingSafeEqual`. A client without the token is
rejected before it can issue requests. Tokens rotate when the Host restarts.

For SSH attach the token never leaves the remote machine. The local client sends
`hello` with an empty token; the remote `--stdio-proxy` reads the descriptor and
injects the current token immediately before forwarding that first frame. Every
later frame is passed through unmodified. A fresh reconnect starts a fresh
proxy, which re-discovers the endpoint, so a Host restart with a new PID, socket
path, and token is handled automatically. The proxy fails closed with an
NDJSON `error` frame and a non-zero exit if the first frame is malformed or is
not `hello`.

## Process permissions

The Host plugin runs with DSH's permissions. Approvals and sandbox settings still
govern model actions; the terminal does not bypass them. Do not expose the bridge
to another user or run it from an untrusted account.

## First-win approval companion

`approvals: first-win` adds a same-origin `GET /dsh-attach/interactions` SSE
route to DSH's existing web server. It does not start a new listener. The
stream carries only settled interaction facts (`sessionId`, `callId`, outcome,
winner) for the Web companion to close the losing native approval panel; it
cannot approve anything. The route checks `connection.requestRejection` when
the DSH connection service is available. The settlement log is bounded to 128
entries and is replayable across a Web reconnect.

## Terminal injection

Host/model/tool output, titles, questions, and queue text are sanitized: CSI,
OSC, and dangerous C0/C1 control sequences are removed before display. This
prevents model output from controlling the terminal.

## Remote SSH boundary

SSH authentication is the outer boundary for remote attach. `dsh-attach` does
not add an account system, a password prompt, or a network listener; it relies
on the user's existing OpenSSH config, agent, host keys, and `known_hosts`.
`--exec` and `--list` force `BatchMode=yes`, so missing credentials fail instead
of prompting. Keep `StrictHostKeyChecking` enabled; `--ssh-opt` is intentionally
a raw escape hatch for the user's own SSH policy.

The remote side still enforces the same local rules: the proxy must run as the
same OS user as the Host, and the descriptor/socket permissions still apply.
Anyone who can authenticate to that SSH account can operate that Harness. The
local token is not a remote secret and is not trusted by the Host.

## Local-only by default

Without `--ssh`, there is no network listener, relay, or cloud service. Unix
socket/Named pipe and descriptor files are the entire transport. With `--ssh`,
the only network component is the user's own SSH connection; the Host remains
local-only.

## Auto-approval

Auto-approval is opt-in. `rules` mode uses a deterministic structured
whitelist; `review` mode applies a global policy to every approval through an
isolated LLM reviewer. `--exec --approval-rules` uses the same matcher and
review route for one headless run; unmatched calls are denied or delegated,
never implicitly allowed.
Failures fall back to a human. It is **not** a security boundary: the reviewer
can be fooled by prompt injection. `danger-full-access` requires explicit opt-in
and still grants all user-accessible paths. Keep the config outside the
workspace and review it like executable policy.

Bash rules use ordered token prefixes, not user regex. Compound lines are
split, wrappers and env assignments are stripped, and every non-read-only
subcommand must match a rule. Substitutions, subshells, heredocs, and loops
fail closed. Suggestions produce token prefixes (or literal path prefixes) and
are validated against the actual call; `humanOnlyPrefixes` always asks.

## Session rules

`s` in the approval panel creates a narrow, session-scoped rule; `a` appends the
same rule to the durable file after confirmation. Session rules are runtime
state, owned by one terminal connection: they are cleared on Session switch,
disconnect, or Host stop, and never written to disk. When the Host exposes
`approval.session-allow`, it mirrors the rule and settles matching
`approval/request` calls before any panel is broadcast. Host-side matching is
fail-closed on a missing `callId`, an unresolvable tool call, non-JSON
arguments, an unparseable shell line, or `danger-full-access` without the
explicit full-access marker. `approvals: off` skips mirrored rules entirely. A
Host that does not expose the route keeps the rule in the terminal only. Quick
actions are disabled for a background child approval because their grants would
otherwise apply to the parent Session.

## Runtime writable roots

`w` and `/sandbox allow-dir` use DSH's
`ctx.sandboxPolicy.registerWritableRoot()` for one Session. They are not a
sandbox override: the directory is validated as an existing absolute physical
path (realpath, no symlink target) before registration, grants are runtime-only,
and they disappear on detach, Session switch, Host restart, resume, or fork.
`/sandbox revoke-dir` removes the calling connection's grant. A Host without
`sandboxPolicy` reports the route as unsupported rather than silently widening
permissions, and `danger-full-access` is never granted implicitly.

## Out of scope

- Malicious same-user processes (they can read the descriptor/token).
- A compromised DSH Host or model.
- Terminal emulator vulnerabilities.
- Multi-user access to the same Host account.
- The security of the user's SSH configuration, agent forwarding, or remote
  account.

## Operations

- Trigger a profile recomposition after upgrades (Plugin Manager or profile
  patch change); a manual install needs it.
- Restrict `$DSH_HOME` permissions.
- Remove stale descriptors only when no matching Host is running.
- On Windows, protect the profile directory with normal user ACLs.

## Herdr environment

Only `HERDR_*` variables are accepted from a client, bounded in count/size and
merged into model shell requests. Managed DSH environment remains authoritative.
