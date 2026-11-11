# Security

`dsh-attach` is a local control surface. It adds no remote access and no second
authorization layer.

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

## Authentication

Each Host generates a 32-byte random token, stores it in the descriptor, and
compares a SHA-256 hash with `timingSafeEqual`. A client without the token is
rejected before it can issue requests. Tokens rotate when the Host restarts.

## Process permissions

The Host plugin runs with DSH's permissions. Approvals and sandbox settings still
govern model actions; the terminal does not bypass them. Do not expose the bridge
to another user or run it from an untrusted account.

## Terminal injection

Host/model/tool output, titles, questions, and queue text are sanitized: CSI,
OSC, and dangerous C0/C1 control sequences are removed before display. This
prevents model output from controlling the terminal.

## Local-only

No network listener, relay, or cloud service. Unix socket/Named pipe and
descriptor files are the entire transport.

## Auto-approval

Auto-approval is opt-in. `rules` mode uses a deterministic whitelist plus an
isolated LLM reviewer; `review` mode applies a global policy to every approval.
Failures fall back to a human. It is **not** a security boundary: the reviewer
can be fooled by prompt injection. `danger-full-access` requires explicit opt-in
and still grants all user-accessible paths. Keep the config outside the
workspace and review it like executable policy.

## Out of scope

- Malicious same-user processes (they can read the descriptor/token).
- A compromised DSH Host or model.
- Terminal emulator vulnerabilities.
- Remote/multi-user access.

## Operations

- Trigger a profile recomposition after upgrades (Plugin Manager or profile
  patch change); a manual install needs it.
- Restrict `$DSH_HOME` permissions.
- Remove stale descriptors only when no matching Host is running.
- On Windows, protect the profile directory with normal user ACLs.

## Herdr environment

Only `HERDR_*` variables are accepted from a client, bounded in count/size and
merged into model shell requests. Managed DSH environment remains authoritative.
