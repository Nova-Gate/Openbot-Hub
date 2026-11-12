# OpenBot Hub delivery roadmap

This roadmap sequences the requirements in `docs/product-requirements.md`. Status and evidence live in `docs/requirements-matrix.md`.

## Operating rule

Work on one milestone at a time. Each implementation change references requirement IDs and updates the matrix. A milestone is complete only when its exit gate passes. Do not start later features merely because they are easier or more interesting; Mo may explicitly reprioritize by updating these documents.

Army Hub remains independent and untouched. Every milestone retains the account-free, single-application, no-telemetry boundaries.

## M0 — Local foundation

**Status: complete as a local proof of concept.**

Delivered:

- Account-free custom web application and persistent Mac LaunchAgent.
- Global Army room and project-room creation/selection.
- Persistent fake-agent registry and lifecycle controls.
- Local-fake and authenticated remote-ACP execution paths.
- Durable demo sessions, room-scoped mentions, idempotent posts, and live updates.
- Offline integration tests and repeatable desktop/phone-width browser acceptance.

Limits: fake agents only; the demo Dell node runs on the Mini; phone evidence is a 390 px browser viewport, not a physical phone.

## M1 — Supervision and room completion

**Status: complete. Exit gate passed on 2026-11-02 with CHECK, APP, ACP, SUP, and UI evidence.**

Requirements: ROOM-03, AGENT-03, EXEC-01, EXEC-02, EXEC-03, EXEC-04.

### Work

- Rename project rooms, edit purpose/membership, and delete non-global rooms with explicit history behavior.
- Add agent connectivity checks and accurate available/unavailable/misconfigured/disabled/session states.
- Prove per-agent queue ordering and concurrent idempotency behavior.
- Add queued, running, waiting, completed, failed, interrupted, and unknown execution records where applicable.
- Add stop controls for queued and active work with resource cleanup.
- Add safe retry only for known-safe failures; surface unknown outcomes without automatic resubmission.
- Extend the fake harness to script slow work, failure, interruption, and recovery deterministically.
- Preserve all M0 regression tests and add browser supervision flows.

### Exit gate

Mo can create/edit/delete a project room, test an agent, watch a slow turn progress, stop it, retry an eligible failure, and restart the app without losing state or duplicating execution. APP, ACP, SUP, CHECK, and UI evidence passes for the new behavior.

M1 does not require real harnesses, physical devices, approvals, attachments, or delegation.

## M2 — Real work and files

**Status: active. Real OpenCode file/session, detailed native approval, native form-question, stop/failure supervision, descendant cleanup, same-session recovery, rich tool/plan progress, and deliberate attachment acceptance passed on 2026-11-03; generated-file return keeps the milestone open.**

Requirements: AGENT-02, AGENT-04, EXEC-05, EXEC-06, EXEC-07, FILE-01, FILE-02.

### Work

- **Done:** Add one real local OpenCode ACP adapter with configurable non-secret CLI and disposable workspace paths.
- **Done:** Verify native file tools, execution identity, queued/running/completed history, provider-credential isolation, and durable native session resume through the shared runtime after a Hub restart.
- **Done:** Round-trip native `elicitation/create` form questions and permission approvals with explicit pending/terminal states, complete safely rendered operation details, expiry, waiting stop, wrong-session rejection, and restart recovery.
- **Done:** Verify real OpenCode active stop, induced provider-crash failure, descendant process cleanup, and subsequent execution in the same native session.
- **Done:** Render durable tool calls, plans, results, and failures with node attribution; prove coalescing, restart persistence, replay suppression, real OpenCode result evidence, and desktop/phone rendering.
- **Done:** Add deliberate attachment upload with type/size limits, room-scoped retry receipts, UUID storage, hashes, ACP byte delivery to local and remote agents, verified downloads, mobile composition, and deletion cleanup.
- Add generated-file return with limits, hashes, preview, and containment.
- Keep provider credentials on the execution machine and out of logs, prompts, Git, and registry state.

The live `REAL` evidence is separate from offline tests: file/session acceptance uses two small model calls, and supervision acceptance uses five. Both verify task artifacts within isolated acceptance roots; they do not claim an operating-system sandbox or restrict OpenCode's own profile/session storage. DSH remains an independent future adapter.

### Exit gate

A real agent completes a disposable task with native tool evidence, answers a question, receives an approval, exchanges files deliberately, resumes its session, and passes failure/restart tests without exposing credentials. Native file evidence, attachment delivery, session resume, detailed approval, native form question, stop/failure supervision, recovery, and rich progress now pass; generated-file return remains.

## M3 — Teams and controlled coordination

**Status: planned.**

Requirements: TEAM-01, TEAM-02, TEAM-03, TEAM-04.

### Work

- Add reusable team definitions and team mentions.
- Add controlled agent-to-agent delegation with origin/depth/routing limits.
- Maintain shared task state and synthesized results in the originating room.
- Enforce a global execution and anti-loop budget across agents and nodes.

### Exit gate

A team containing at least two agents completes a scripted coordinated task, delegation remains within policy, restart preserves task state, and a forced loop stops at the global budget.

## M4 — Physical machines and phone

**Status: planned.**

Requirements: NODE-02, NODE-03, NODE-04, MOBILE-02, MOBILE-03, SEC-02.

### Work

- Enroll the physical Dell and MacBook with node-specific identities, credentials, and isolated workspaces.
- Prove traversal, symlink, and Mini-path fallback protections.
- Add application authentication/authorization before non-loopback web exposure.
- Connect Mo's physical phone through Tailscale or an equivalent private route.
- Add an installable phone shell if it improves daily use without creating a second product.
- Test background/foreground behavior, Wi-Fi/cellular transitions, queued sends, and reconnect reconciliation.

### Exit gate

From the physical phone, Mo addresses real Mini, Dell, and MacBook agents in one room, receives correct host/workspace evidence, changes networks, and resumes without duplicate messages or execution. No unauthenticated listener or second chat application is present.

## M5 — Production readiness and V1 acceptance

**Status: planned.**

Requirements: CORE-03, SEC-01, SEC-03, OPS-02, OPS-03, OPS-04, plus final verification of all P0/P1 requirements.

### Work

- Test state migrations and interrupted-execution recovery across all supported adapters.
- Demonstrate backup and restore into an isolated acceptance instance.
- Rotate/revoke credentials and safely remove nodes.
- Audit permissions, secret handling, request limits, and network egress.
- Verify no analytics, billing, reporting, or unwanted hosted-service traffic.
- Run the complete V1 release scenario from the requirements sheet.

### Exit gate

Every P0/P1 requirement is Done in the matrix, the phone-to-multi-machine release scenario passes, backup restoration succeeds, and no unknown outcome is blindly retried.

## Delivery order

```text
M0 Local foundation
  → M1 Supervision and room completion
  → M2 Real work and files
  → M3 Teams and controlled coordination
  → M4 Physical machines and phone
  → M5 Production readiness and V1 acceptance
```
