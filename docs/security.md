# Security model

`dsh-attach` is a local control surface for a running DeepSeek Harness. It is
not a remote-access server, and it does not add a new authorization layer on top
of the Host. Its security boundary is the operating-system user account.

## Trust boundary

The terminal client runs as the **same user** as the Host process. Once
connected, it can list sessions, open them, send prompts, cancel turns, switch
models, control subagents, and answer approvals or questions with the same
authority as that user.

**Anyone who can connect to the socket can operate the Harness.** Protect the
account, the `$DSH_HOME` directory, and the endpoint descriptor accordingly. Do
not run the client from an untrusted account or share the token.

## Transport

- The bridge listens on a Unix-domain socket only. There is no TCP listener and
  no extra port.
- The default socket is `$DSH_HOME/dsh-attach/attach-<pid>.sock`, or a
  temporary-directory path when the default would exceed the platform limit.
- The endpoint directory is created with mode `0700`. The socket is `chmod`ed
  to `0600`.
- The Host writes `endpoint.json` and a per-profile descriptor
  (`<profile>-<pid>.json`) with mode `0600`. A descriptor contains the protocol
  version, plugin version, Host PID, socket path, profile, `DSH_HOME`, start
  time, and the random token.

Descriptor example, with the token abbreviated:

```json
{
  "protocol": 1,
  "plugin": "dsh-attach",
  "pluginVersion": "2026.1108.2336",
  "pid": 12345,
  "socketPath": "/Users/me/.dsh/dsh-attach/attach-12345.sock",
  "token": "<redacted>",
  "profile": "desktop",
  "home": "/Users/me/.dsh",
  "startedAt": 1750000000000
}
```

## Authentication

- Each Host process generates a new 32-byte random token and advertises it in
  the descriptor.
- The first line on a new connection must be a `hello` carrying that token.
- The Host stores a SHA-256 hash of the token and compares it with
  `crypto.timingSafeEqual`, so token comparison does not leak length or prefix
  information through timing.
- An unauthenticated connection is closed after 10 seconds. A bad token,
  malformed JSON, an oversized inbound line, or a protocol violation closes the
  connection.
- Inbound lines are capped at 4 MiB; outbound lines at 64 MiB. Outbound writes
  respect backpressure so a stalled client does not build an unbounded queue.
- The descriptor is removed on shutdown only when its token matches the current
  process, so a stale Host cannot delete a newer endpoint.

The token is a bearer credential. It is redacted from the lifecycle log
(`--token <redacted>`), but it is stored in the descriptor by design so that
`dsh-attach` can authenticate. Anyone who can read the descriptor can use the
token.

## Process permissions

The bridge calls the live `sessionController`, approval waterfall, question
service, command registry, and model catalog of the Host. It does not
re-implement sandboxing, policy, or approval decisions.

As a result:

- a connected TUI can answer an approval that the Host would otherwise show in
  the Web GUI;
- the TUI's approval answer applies the same policy and has the same effect as
  an answer from the Web GUI;
- when several clients hold the same request, the first answer wins, and the
  other panels close;
- subagent follow-ups and stops use the Host's own `ctx.subagents` authority:
  a follow-up requires the exact live direct parent, and a stop is addressed by
  the durable parent; neither route grants access to an unrelated session;
- the terminal does not gain permissions the user does not already have.

Approval and question routing is configurable. The default `tui` mode prefers
the terminal while it is watching the session. See
[Configuration](configuration.md).

## Terminal injection

Model output, tool output, question text, approval reasons, and session titles
are untrusted. Before rendering, the client strips:

- OSC sequences, including clipboard and hyperlink control;
- CSI sequences;
- other two-byte escape sequences;
- C0 controls (except tab, newline, and carriage return) and C1 controls.

Line breaks and tabs are preserved so Markdown and code blocks render normally.
Image content blocks are displayed as the literal text `[image]`. Clipboard
images are read locally by the client and sent to the Host only when the prompt
is submitted. Automatic interrupted-turn continuation sends a normal user
prompt; it can repeat side-effecting work, so set `DSH_ATTACH_AUTO_RESUME=0`
when that risk is unacceptable.

This prevents a model or tool from driving the terminal through output text. It
does not protect against vulnerabilities in the terminal emulator itself, nor
against a compromised Host process, which already has the user's full
permissions.

## Local-only by design

The bridge is not reachable from the network:

- no TCP listen;
- no TLS or network authentication layer;
- no forwarding or tunneling built in.

To use the TUI over SSH, run `dsh-attach` on the remote machine next to the Host.
SSH access to that account already grants the ability to run the client locally;
the attach socket does not widen that access.

## Out of scope

The design does not defend against:

- a malicious process or user with the same UID;
- root or an administrator who can read `$DSH_HOME`;
- a compromised DeepSeek Harness or plugin build;
- a terminal emulator or SSH client vulnerability;
- prompt-injection attacks that cause the agent to request dangerous tools. Use
  the Host's approval policy and sandbox settings for that threat.

## Operational advice

- Keep the endpoint directory and descriptor at `0700`/`0600`.
- Do not copy `endpoint.json` into shared storage or paste its token into logs.
- Leave `DSH_ATTACH_KEYS` off except during temporary debugging; it records raw
  input, which may include prompt text.
- Use the default `tui` routing only when you want the terminal to own approvals
  while it is watching a session. Use `web` or `off` otherwise.
- Restart the Host after upgrading the plugin so the new socket code is active.
- Windows is not supported; do not rely on named-pipe permission semantics.


## Herdr environment forwarding

When the client runs in a managed Herdr pane, it forwards only `HERDR_*`
variables to the Host, scoped to the followed session. The bridge rejects other
names and merges them only into model shell requests. This is deliberate: it
lets shell commands address the same pane without exposing the terminal's full
environment or credentials.
