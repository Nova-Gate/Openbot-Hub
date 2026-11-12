# OpenBot Hub product requirements

- **Document status:** Authoritative product baseline
- **Version:** 1.0
- **Date:** 2026-11-04
- **Owner:** Mo

This document defines what OpenBot Hub must become and what “full-feature ready” means. `docs/migration-plan.md` defines delivery order. `docs/requirements-matrix.md` tracks implementation and acceptance evidence.

## Change rule

Every feature change must reference at least one requirement ID. A requirement is complete only when its acceptance evidence is recorded in the matrix. If scope, behavior, or priority changes, update this document, the roadmap, and the matrix in the same change. Do not treat a working demo as completion of a broader requirement.

## 1. Product definition

OpenBot Hub is a private, account-free coordination application for Mo's agents across machines and harnesses.

From one phone or desktop interface, Mo can assemble agents into rooms and teams, assign and supervise real work, exchange files, and trust that execution remains on the assigned machine and recovers safely.

Upstream OpenBot is an architectural reference, not a runtime dependency. The product must not require email verification, a vendor account, hosted OpenBot services, Element, or Matrix.

## 2. Primary user and core scenarios

The primary user is Mo, acting as the operator of a personal agent fleet. Multi-user organization administration is not a V1 requirement.

Core scenarios:

1. Mo opens one Army room and addresses agents on any enrolled machine without selecting a host.
2. Mo creates a project room or reusable team for a focused outcome.
3. Mo assigns work to one agent, several agents, or a team and sees coherent progress in the originating room.
4. Mo answers questions, approves actions, stops work, and safely retries eligible failures.
5. Mo sends source material and receives generated files with integrity and execution-location evidence.
6. Mo uses the same room and agent identities from a phone while moving between networks.
7. Mo restarts the app, connector, or machine without silently duplicating work.
8. Mo can back up, restore, rotate credentials, and remove an agent or node without exposing secrets.

## 3. Priorities and completion states

Priorities:

- **P0:** Essential foundation and safe coordination shell.
- **P1:** Required for the full-feature V1 release.
- **P2:** Useful follow-on capability; not required for V1.

Matrix states:

- **Done:** Acceptance evidence passes for the stated scope.
- **Partial:** Some behavior or evidence exists, but the requirement is not complete.
- **Next:** Included in the active milestone but not complete.
- **Planned:** Assigned to a later milestone.
- **Excluded:** Intentionally outside the product scope.

Full-feature V1 requires every P0 and P1 requirement to be Done, followed by the final release scenario in Section 10.

## 4. Non-negotiable product rules

- One user-facing application; no second chat client or host-specific control plane.
- One global Army room plus focused project rooms and reusable teams.
- Execution stays on each agent's assigned physical machine.
- A transport reconnect is never permission to repeat an unknown side effect.
- Every agent result has stable origin, author, and execution-node identity.
- Secrets never enter Git, prompts, message history, or the agent registry.
- Central paths and tools are never silently treated as remote paths and tools.
- Payment, billing, hosted execution, user reporting, external analytics, and telemetry are excluded.
- Complete OpenBot feature parity is not the V1 goal. Selected leads, task revisions, Continue/Reassign, and Archive/Restore are post-V1 unless separately approved; V1 coordination remains rooms, teams, controlled delegation, and synthesized results.
- The server remains loopback-only until authenticated remote access is implemented.

## 5. Functional requirements

### Core application and state

| ID | Priority | Requirement |
|---|---|---|
| CORE-01 | P0 | Provide one account-free responsive web application with no upstream OpenBot, email, vendor-account, or hosted-service dependency. |
| CORE-02 | P0 | Run as a persistent Mac user service that starts at login and restarts after failure. |
| CORE-03 | P1 | Persist rooms, registry data, messages, sessions, receipts, and execution state with tested migration and recovery behavior. |

### Rooms and conversation

| ID | Priority | Requirement |
|---|---|---|
| ROOM-01 | P0 | Provide one global Army room containing every enabled agent without host switching. |
| ROOM-02 | P0 | Create and select project rooms with explicit membership and separate transcripts. |
| ROOM-03 | P0 | Rename rooms, edit purpose and membership, and safely delete non-global rooms. |
| ROOM-04 | P0 | Route direct mentions and `@everyone` only to enabled members of the originating room. |

### Agent and harness management

| ID | Priority | Requirement |
|---|---|---|
| AGENT-01 | P0 | Add, edit, disable, re-enable, and remove agents while preserving historical messages. |
| AGENT-02 | P0 | Maintain a transport-independent agent runtime with local and remote connector paths. |
| AGENT-03 | P0 | Test agent connectivity and expose accurate availability, configuration, session, and error information. |
| AGENT-04 | P1 | Support at least one real DSH or OpenCode agent with durable sessions and native execution, then add other required harnesses independently. |

### Execution supervision and reliability

| ID | Priority | Requirement |
|---|---|---|
| EXEC-01 | P0 | Serialize work per agent, preserve origin IDs, and suppress duplicate user-post execution using stable idempotency keys. |
| EXEC-02 | P0 | Expose queued, running, waiting, completed, failed, interrupted, and unknown states where applicable. |
| EXEC-03 | P0 | Stop queued or active work and release resources without creating an unintended parallel session. |
| EXEC-04 | P0 | Retry only known-safe failures and reconcile interrupted work without blindly repeating unknown outcomes. |
| EXEC-05 | P1 | Round-trip harness questions and approvals in the originating room with explicit pending and terminal states. |
| EXEC-06 | P1 | Display tool calls, progress, and final results with accurate execution-node attribution. |
| EXEC-07 | P0 | Provide execution-location and workspace evidence for every accepted real or fake execution path. |

### Teams and coordination

| ID | Priority | Requirement |
|---|---|---|
| TEAM-01 | P1 | Create reusable teams and address their enabled members through a team mention. |
| TEAM-02 | P1 | Permit controlled agent-to-agent delegation with origin tracking and explicit routing limits. |
| TEAM-03 | P1 | Maintain shared task state and return a coherent synthesized result to the originating room. |
| TEAM-04 | P1 | Enforce a global execution and anti-loop budget across agents and machines. |

### Files

| ID | Priority | Requirement |
|---|---|---|
| FILE-01 | P1 | Send attachments deliberately with type/size limits, hashes, retry-safe transfer, and workspace containment. |
| FILE-02 | P1 | Return and preview generated files without assuming a shared filesystem across nodes. |

### Execution nodes

| ID | Priority | Requirement |
|---|---|---|
| NODE-01 | P0 | Provide an authenticated remote-ACP connector with node-specific credentials and no unauthenticated listener. |
| NODE-02 | P1 | Enroll and prove execution on the physical Dell. |
| NODE-03 | P1 | Enroll the MacBook and support future nodes using the same identity and isolation model. |
| NODE-04 | P1 | Contain remote workspaces and prevent traversal, symlink escape, and Mini-path fallback. |

### Phone experience

| ID | Priority | Requirement |
|---|---|---|
| MOBILE-01 | P0 | Provide usable chat, navigation, and management forms at phone widths. |
| MOBILE-02 | P1 | Access the same rooms and agents from Mo's physical phone through authenticated private connectivity. |
| MOBILE-03 | P1 | Support an installable phone experience with foreground/background and cross-network reconnect without duplication. |

### Security and operations

| ID | Priority | Requirement |
|---|---|---|
| SEC-01 | P0 | Use loopback-only defaults and include no payment, reporting, analytics, telemetry, or unwanted hosted-service flows. |
| SEC-02 | P1 | Add application authentication and authorization before any non-loopback web exposure. |
| SEC-03 | P1 | Protect connector and provider secrets with OS-appropriate storage, redaction, and least-privilege access. |
| OPS-01 | P0 | Provide service management instructions and preserve application state across service restarts. |
| OPS-02 | P1 | Demonstrate backup and restore of Hub state, sessions, registry, and required node configuration. |
| OPS-03 | P1 | Support credential rotation, agent disablement, and safe node removal. |
| OPS-04 | P1 | Complete security, permission, and network-egress review with no unwanted external traffic. |

### Follow-on, not required for V1

| ID | Priority | Requirement |
|---|---|---|
| EXP-01 | P2 | Add conversation search, filtering, and notification preferences based on observed daily use. |
| EXP-02 | P2 | Add reusable task templates and scheduled agent workflows after execution recovery is reliable. |

## 6. Experience and design requirements

- Chat remains the primary surface; management belongs in the room rail, execution directory, and focused dialogs.
- The Army room is always available and never deletable.
- Agent identity, node, availability, and execution state must be legible without opening developer tools.
- Phone layouts use the same application and data, with accessible drawers and forms rather than a reduced second product.
- Destructive actions require clear confirmation and explain history effects.
- Never show success before the corresponding operation reaches a known state.
- Preserve the established cream, navy, yellow, pink, and lavender visual system, monospace technical metadata, and responsive three-pane/single-room layouts.
- No external font, analytics, advertising, or tracking dependency is needed for the interface.

## 7. Data and execution invariants

- Every message belongs to a room and has a stable ID.
- Every execution request has an origin ID; agent replies reference that origin.
- User retries with the same accepted client message ID do not create another execution.
- Removing an agent removes registry membership but preserves message history.
- The Army room includes all enabled agents; project-room execution includes only enabled members.
- Changing execution configuration invalidates incompatible session references; presentation changes do not.
- Remote work must fail explicitly rather than silently execute on the Mini.
- Unknown or interrupted outcomes require reconciliation, not automatic resubmission.

## 8. Current baseline

The local application has established the account-free app, persistent service, Army room, complete project-room lifecycle, persistent agent registry, fake local and remote-ACP execution, a real local OpenCode ACP adapter, durable native and demo sessions, execution evidence, connectivity health, execution supervision, queued/active stop, process-tree cleanup, room-bound native questions/approvals with complete operation details, durable rich tool/plan progress with node attribution, deliberate attachment upload/delivery/download, known-safe retry, unknown-outcome recovery, responsive management screens, and offline integration/browser tests.

Real OpenCode acceptance has proven embedded-resource reading with the marker absent from instruction text, exact native file creation, correct origin/agent/node/room identity, queued/running/waiting/completed history, workspace-only task artifacts within an isolated acceptance root, native session resume after a Hub restart, a completed real tool event with result evidence and no replay duplicates, detailed native permission approval, a real `elicitation/create` form question, active stop, provider-failure recording, descendant cleanup, and successful post-failure execution in the same native session. Provider credentials remain in OpenCode's own profile rather than Hub configuration. This acceptance is not an operating-system sandbox and does not prevent OpenCode from maintaining its own profile/session storage.

This baseline is not full-feature V1. Other real harnesses, physical multi-machine execution, secure phone connectivity, teams, generated-file return, and production recovery remain incomplete.

## 9. Active milestone: M2 real work and files

M1 supervision and room completion passed its exit gate on 2026-11-02. M2 is active. AGENT-02, AGENT-04, EXEC-03, EXEC-05, EXEC-06, EXEC-07, and FILE-01 now have acceptance evidence, including real OpenCode embedded-resource delivery; the complete M2 exit gate remains open. The milestone includes:

- AGENT-02 and AGENT-04: shared-runtime and real OpenCode acceptance are Done; add other required harnesses independently.
- EXEC-05: room-bound questions/approvals are Done, including real OpenCode native question and detailed-permission evidence.
- EXEC-06: durable tool calls, plans, results, failures, and execution-node attribution are Done in APP/UI and real OpenCode acceptance.
- EXEC-07: real OpenCode execution-location and workspace evidence is Done; physical-node evidence remains under M4.
- FILE-01: deliberate attachments are Done with integrity, retry, room/message binding, local/remote delivery, restart-download, deletion-cleanup, desktop/mobile, and real OpenCode evidence.
- FILE-02: generated-file return with integrity, preview, and containment checks remains.
- Regression evidence for all previously completed requirements.

M2 does not claim physical phone access, physical Dell/MacBook enrollment, reusable teams, or production readiness.

## 10. Full-feature V1 release gate

The final release scenario is:

1. From Mo's physical phone, open the global Army room through authenticated private connectivity.
2. Address a reusable team containing real Mini and physical Dell agents.
3. Attach source material and assign a coordinated task.
4. Observe room-scoped progress and execution-node evidence.
5. Answer a question, approve a safe operation, and stop a separate queued operation.
6. Restart the Dell connector during a controlled turn and reconcile the outcome.
7. Return to the same thread after a network transition and verify one coherent result with no duplicate turn.
8. Retrieve generated files and verify their integrity.
9. Confirm no Element, vendor account, host switching, hidden Mini execution, telemetry, or billing flow was involved.
10. Restore the deployment from backup in a separate acceptance run.

Only when this scenario and every P0/P1 requirement pass can OpenBot Hub be called full-feature ready.
