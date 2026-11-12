# OpenBot Hub architecture

## Decision

OpenBot Hub is a custom, account-free application hosted on the Mac mini. It provides one responsive web interface and one global Army room; execution is distributed to agents on their assigned machines.

Upstream OpenBot is an architectural reference, not a runtime dependency. The application does not require OpenBot installation, email verification, vendor accounts, hosted services, billing, reporting, analytics, or telemetry. Useful protocol ideas and modules may be adopted selectively, with upstream notices preserved whenever code is copied or modified.

This deliberately avoids:

- Element, Matrix, or a second chat application.
- A separate control plane and host-specific room on every machine.
- Blindly running remote agents on the Mac mini.

Army Hub remains a separate, untouched repository and runtime.

## Current topology

```text
                    Desktop or phone browser
                              │
                              ▼
              Mac mini: OpenBot Hub web application
              ┌───────────────────────────────────┐
              │ One global Army room              │
              │ Agent directory and durable state │
              │ Per-agent queues and live updates │
              └───────────────┬───────────────────┘
                              │
                    Local ACP │ Remote ACP connector
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
       Mini-local harness             Execution-node server
       and workspace                  on Dell / MacBook / future node
                                      ┌─────────┴─────────┐
                                      ▼                   ▼
                                Native harness      Node workspace
                                and sessions        and durable state
```

The current demo implements both paths on the Mac mini. Its `demo-dell` node proves transport and workspace separation, not execution on a physical Dell.

## Ownership

### Central OpenBot Hub application

Owns:

- The global Army room, project rooms, shared transcripts, and agent directory.
- Project-room rename, purpose/membership editing, and confirmed history deletion.
- Persistent agent definitions and references to their harness sessions.
- Per-agent execution queues and persisted supervision records.
- Durable, size-bounded tool and plan progress on each execution, with coalesced tool updates, sanitized operation input/output, and authoritative execution-node attribution.
- Room-bound ACP permission requests and native form questions with explicit pending and terminal decision records; permission operation details are preserved, redacted, and rendered as text.
- Direct mentions, room-scoped `@everyone`, idempotent user-post receipts, and a six-turn request limit.
- Deliberate room-bound attachments with owner-only UUID storage, size/type checks, SHA-256 receipts, retry deduplication, verified downloads, and one-message use. Bytes remain outside JSON state and are delivered as ACP content blocks.
- Live browser updates over server-sent events.
- Host-independent agent addressing.

It does not yet own generated-file return, autonomous delegation, or reusable teams.

### Execution-node connector

Owns:

- Authenticated connector handshakes.
- Translation between central ACP requests and the node-local harness.
- Node-specific workspace and state roots.
- Durable harness sessions and execution-location evidence.

It must not:

- Expose an unauthenticated ACP listener.
- Put credentials in prompts, logs, registry files, or Git.
- Silently execute a remote agent's work on the Mini.
- Blindly retry a turn whose execution outcome is unknown.

The current connector uses authenticated raw TCP and is accepted only as a loopback demo. Before physical-machine deployment in M4, traffic must use a protected Tailscale path or TLS with explicit binding rules.

### Harness on each machine

Owns its native provider authentication, tools, workspace behavior, and local project memory. Local-fake and remote-fake harnesses support deterministic offline acceptance. The real `local-opencode` adapter launches the installed OpenCode CLI over ACP, reuses its native provider profile and session storage, and passes real work through the same Hub queue and execution boundary.

## Agent and room configuration

The built-in demo seeds two agents on first run. After that, the persistent registry in the Hub state file is authoritative; the UI can create, edit, disable, re-enable, and remove definitions. The server also accepts `--agents <json-file>` to seed isolated test instances. Secrets must never be stored in the registry or committed.

Each agent maps:

```text
Hub agent ID ↔ execution node ID ↔ harness session ID ↔ workspace
```

Local-fake agents define `workspace` and `state`; remote-ACP agents reference a connector config containing node address, agent ID, and a local token-file reference. OpenCode agents require a non-secret CLI path and an explicit workspace; one workspace cannot be owned by multiple OpenCode agents. Editing execution configuration stops the old connector and resets its session reference; editing only presentation or enabled state preserves it. Removing an agent deletes its registry membership but not its historical messages.

The Army room is global and always addresses every enabled agent. Project rooms persist explicit member lists. Removing an agent also removes its project-room memberships.

## Message and session flow

1. Optional files upload as raw binary bodies with a room-scoped client attachment ID. The Hub validates filename, media type, size, and content, writes bytes under a random UUID, and persists only metadata, SHA-256, and the receipt. An identical retry returns the original attachment; a conflicting retry fails without duplicating bytes.
2. Mo posts in the selected room with a client message ID and up to four unused attachment IDs from that room.
3. Hub marks the attachments used, stores their public metadata on the message and its idempotency receipt, then starts execution.
4. Leading mentions select enabled room members; `@everyone` selects all enabled members in that room.
5. Each selected agent enters its own serial queue.
6. Before prompting, the Hub rereads every attachment and verifies size and SHA-256. Text/PDF resources and images become ACP content blocks after the text block; central paths are never substituted.
7. The runtime creates or resumes the agent's durable ACP session.
8. Local agents execute directly; remote agents pass through the authenticated node connector with the same content blocks and source bytes.
9. ACP `session/update` notifications are handled sequentially and bound to the active execution/session; session-load replay is drained before activation. Tool calls and plans persist as coalesced, redacted execution events with Hub-assigned node IDs, and `prompt` waits for event persistence before returning. ACP `session/request_permission` requests pause the execution as `waiting` and appear in the originating room with the complete sanitized operation snapshot. The browser renders commands, raw input, paths/locations, content, and diffs as text before Mo selects an option. ACP `elicitation/create` form questions use the same room and execution binding; structured answers, decline, and cancel return to the native session. Rejection, expiry, stop, and provider failure produce explicit terminal records.
10. Replies return to the originating room with author, origin, and execution-node identity.
11. Saved session IDs and attachment metadata are reused after application restart; downloads verify the bytes again, and room deletion removes that room's attachment receipts and files.

A repeated client message ID returns the original receipt and starts no new execution. Automatic recovery of an interrupted active turn is not implemented and must not be assumed safe. Real OpenCode acceptance covers detailed permission approval, a native form question, active stop, provider-crash failure, descendant cleanup, and subsequent execution in the same native session.

## State and failure rules

- A missing state file seeds a new demo; an unreadable, malformed, or non-object state file aborts startup without replacing the original.
- Loading a valid existing state creates a `.load-backup` copy before the Hub writes its recovered representation.
- ACP spawn/stream failures reject pending work and reset startup state rather than terminating the Node process.
- Manual stops and unexpected provider exits clean up the ACP process tree; subsequent work starts a fresh ACP process without creating a second native session.
- Permission and question decisions are bound to the exact execution and native session. Pending decisions cannot be answered twice, answered with an invalid value, or resumed after stop, expiry, provider failure, or restart. The pending resolver and expiry timer are registered before persistence, so a recorded selection cannot be returned to ACP as a cancellation.
- Active agents cannot be edited or removed; room deletion is blocked during active work or attachment uploads. Once those settle, deletion removes that room's execution and approval history plus attachment metadata, upload receipts, and stored files. Pending-upload guards release on success and failure.
- Provider and connector errors are redacted before health records, execution history, room messages, or HTTP responses persist or display them. Progress titles and operation payloads use the same redaction path, retained events are capped, and an event-persistence failure rejects the active prompt rather than reporting false success.

## Workspace and tool rules

A central path must never be passed blindly to a remote machine. Each remote agent has an explicit node-local workspace root. Execution-proof files record the node ID, hostname, process, session, and actual workspace. Real OpenCode acceptance checks exact native file content and unexpected task artifacts within its isolated acceptance root; this is not an OS-level sandbox.

Attachment transfer is deliberate: the Hub enforces type and size limits, stores bytes by random UUID with owner-only permissions, verifies SHA-256 before execution and download, and sends ACP content blocks rather than central paths. Fake local and remote nodes write exact received bytes under the selected agent workspace's `received-attachments/` directory. Future remote tools require explicit execution-location and authorization tests; central browser or computer-use tools must never be presented as remote-machine tools.

## Security and deployment

- The web server listens on `127.0.0.1` by default and accepts only loopback Host headers.
- Browser JSON mutations require a same-origin `Origin` when supplied, reject cross-site fetch metadata, and require `application/json` for request bodies. Raw attachment upload instead uses `application/octet-stream` on its dedicated route with the same origin protections and explicit filename/media-type/receipt headers. Non-browser CLI requests without an Origin remain supported on loopback.
- Connector credentials are generated locally, stored with owner-only permissions, and excluded from Git.
- Tailscale provides reachability, not application authorization. Secure phone access still needs an authenticated access design before binding the web server to a non-loopback interface.
- No vendor hosted server is required.
- Payment, billing, user reporting, product analytics, and telemetry are outside the product.

## Implementation status

Implemented and tested:

- Account-free responsive Army and project rooms, including complete project-room lifecycle controls.
- Persistent agent lifecycle management with history-preserving removal.
- Local and remote-ACP fake agents plus a real local OpenCode ACP adapter.
- Durable native/demo sessions and state.
- Node-tagged replies and execution evidence.
- Durable coalesced tool/plan progress with operation input/output, failure display, and execution-node labels on desktop and at 390 px.
- Room-scoped `@everyone`, duplicate-post suppression, supervision, and restart recovery.
- Deliberate attachment upload, integrity checks, retry-safe receipts, ACP delivery, verified downloads, mobile composition, and room-deletion cleanup.
- Real OpenCode native file, embedded-resource attachment, completed tool-progress, replay-suppression, and post-restart session-recall acceptance.
- Real OpenCode detailed permission, native form-question, active-stop, provider-failure, descendant-cleanup, and post-failure recovery acceptance.
- Room-bound approval/rejection and native question accept/decline/cancel controls on desktop and at 390 px.
- Desktop and 390 px mobile chat, drawer, attachment, management-form, and OpenCode-form acceptance.

Not yet implemented:

- Reusable teams and controlled delegation.
- Physical Dell and MacBook enrollment.
- DSH, Hermes, or Grok adapters.
- Generated-file return.
- Network user authentication and production hardening.
