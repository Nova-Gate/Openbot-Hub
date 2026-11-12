# Requirements traceability matrix

This is the implementation and acceptance index for `docs/product-requirements.md`. Update it whenever requirement status or evidence changes.

## Evidence commands

- **CHECK:** `npm run check` — JavaScript syntax validation.
- **APP:** `node --test tests/hub-app.test.mjs` — registry, rooms, API routing, idempotency, restart integration, foreign request rejection, and malformed-state preservation.
- **PROG:** `node --test tests/execution-events.test.mjs` — tool/plan normalization and redaction, pending-to-completed coalescing, result/output preservation, authoritative Mini/Dell node attribution, restart persistence, and legacy execution loading.
- **ACP:** `node --test tests/remote-acp.test.mjs` — connector execution, workspace proof, resume, and credential rejection.
- **FILE:** `node --test tests/attachments.test.mjs` — binary upload, exact hashes, retry deduplication/conflicts, size/type/path/content rejection, aborted transfer cleanup, one-room/one-message rules, identical Mini/remote-Dell delivery, restart-safe downloads, delayed-upload/deletion race protection, aborted-upload guard release, legacy state, and room-deletion cleanup.
- **SUP:** `node --test tests/supervision.test.mjs` — connectivity, startup-failure containment, redaction, unique workspaces, concurrent idempotency, queue ordering, fake stop, safe retry, and active-deletion safeguards.
- **DEC:** `node --test tests/approvals.test.mjs tests/elicitation.test.mjs` — native `elicitation/create` questions, complete/redacted operation details, permission allow/reject, question accept/decline/cancel, session binding, invalid/repeated decisions, expiry, waiting stop, active-modification guards, restart recovery, the persistence-decision race, and ACP process-group cleanup.
- **CI:** `.github/workflows/test.yml` — runs CHECK and all offline tests for every PR and push to `main`; browser and live provider evidence remains local.
- **UI:** `npm run test:ui` — isolated Chrome desktop and 390 px phone acceptance, including real file-input upload, hash/status chips, room locking, message metadata, exact downloads and fake-agent bytes, pending/completed tool and plan progress, raw command/output, failure rendering, node labels, visible permission command/path/diff details, and native question accept/decline flows; artifacts are written under ignored `artifacts/ui-validation/`.
- **REAL:** `npm run test:opencode` — two small live OpenCode calls covering embedded-resource attachment reading with the marker absent from instruction text, exact native file evidence, a completed real file tool with result evidence and `mac-mini` attribution, zero replay duplicates, identity, lifecycle, isolated task artifacts, credential-field isolation, and native session resume after Hub restart; report under ignored `artifacts/opencode-acceptance/`.
- **REAL-SUP:** `npm run test:opencode-supervision` — five small live calls proving native permission approval with complete operation details, a real OpenCode form question, active stop, induced provider failure, descendant cleanup, and post-failure recovery in the same native session; report under ignored `artifacts/opencode-supervision/`.
- **SVC:** `launchctl print gui/$(id -u)/com.molaoshi.openbot-hub` plus health/state checks and an intentional `kickstart -k` restart.

`npm test` runs APP, PROG, ACP, FILE, SUP, and DEC. UI requires macOS and Google Chrome. Future physical-phone, Dell, MacBook, security, and backup gates require their own recorded evidence; local simulation is not a substitute.

## Status summary

- **M0:** Local foundation; mostly complete, with broader requirements still partial.
- **M1:** Complete, including real OpenCode stop/failure supervision under EXEC-03.
- **M2:** Active; real OpenCode native execution, session resume, supervision, detailed approvals, native form questions, rich progress, and deliberate attachments passed on 2026-11-03, while FILE-02 generated-file return remains open.
- **M3–M5:** Planned; see `docs/migration-plan.md`.
- No P0/P1 requirement may be called Done from implementation alone; the evidence column must actually pass.

## Core application and state

| ID | Milestone | Status | Acceptance evidence |
|---|---|---|---|
| CORE-01 | M0 | Done | APP checks `accounts:false` and no external analytics flag; UI loads the complete app without sign-in or upstream OpenBot. |
| CORE-02 | M0 | Done | SVC verified running under launchd and automatically recovered after an intentional restart on 2026-11-02. |
| CORE-03 | M5 | Partial | APP proves JSON state, fake-session restart, persisted execution records, and unfinished-to-unknown recovery; backup/restore remains. |

## Rooms and conversation

| ID | Milestone | Status | Acceptance evidence |
|---|---|---|---|
| ROOM-01 | M0 | Done | APP verifies the global Army room and both initial agents; UI addresses agents without host switching. |
| ROOM-02 | M0 | Done | APP creates a member-scoped room and persists it; UI creates, selects, and displays separate transcripts. |
| ROOM-03 | M1 | Done | APP and UI cover rename, purpose/membership editing, confirmed deletion with history/receipt cleanup, active-work deletion blocking, and Army protections. |
| ROOM-04 | M0 | Done | APP proves Army and project-room `@everyone` routing, disabled-agent exclusion, and origin room IDs. |

## Agent and harness management

| ID | Milestone | Status | Acceptance evidence |
|---|---|---|---|
| AGENT-01 | M0 | Done | APP and UI cover add, rename, disable, re-enable, resume, removal, duplicate-name rejection, and history preservation. |
| AGENT-02 | M2 | Done | APP/ACP prove the shared runtime over local-fake and remote-ACP; REAL drives real OpenCode through the same queue, session, execution, and reply boundary. |
| AGENT-03 | M1 | Done | SUP verifies available, unavailable, misconfigured, disabled, and session/unknown transitions; REAL verifies OpenCode availability; UI runs connectivity checks and displays health. |
| AGENT-04 | M2 | Done | REAL passes two live OpenCode turns: exact native file creation, isolated task artifacts, correct identity/lifecycle, no provider credential fields in registry state, and the same native session recalling its token after Hub restart. DSH and other harnesses remain independent future adapters. |

## Execution supervision and reliability

| ID | Milestone | Status | Acceptance evidence |
|---|---|---|---|
| EXEC-01 | M1 | Done | SUP proves concurrent duplicate-post suppression, per-agent queued/running order, and ordered replies; APP retains single-post idempotency coverage. |
| EXEC-02 | M1 | Done | APP/SUP/DEC verify persisted queued/running/waiting/completed/failed/interrupted/unknown histories and result links; REAL-SUP verifies waiting/running transitions on OpenCode; UI exposes applicable states without false success. |
| EXEC-03 | M1 | Done | SUP and UI stop queued/active fake turns; DEC proves process-group cleanup. REAL-SUP passes real active stop, stopped-tool cleanup, induced provider failure, crashed-tool cleanup, a fresh ACP process, and subsequent execution in the same native session. |
| EXEC-04 | M1 | Done | APP/SUP prove unknown recovery without reruns, rejected unknown/interrupted retries, one known-safe fail-once retry, and completed attempt-two linking; UI exercises safe retry. |
| EXEC-05 | M2 | Done | DEC's 9 tests pass native `elicitation/create` questions, structured accept/decline/cancel, backend string-pattern rejection, complete/redacted operation details, permission allow/reject, wrong-session rejection, invalid/repeated decisions, expiry, waiting stop, terminal persistence, restart recovery, and the exact persistence-decision race. UI passes detailed desktop/mobile approval, native question flows, and `0.5` decimal submission with `step="any"`; REAL-SUP passes five calls including a detailed native OpenCode permission and genuine form-question round trip in the same session. |
| EXEC-06 | M2 | Done | PROG passes tool/plan normalization and redaction, pending-to-completed coalescing, raw input/output preservation, authoritative `mac-mini`/`demo-dell` attribution, restart persistence, and legacy execution loading. UI passes pending/completed progress, command/output, plan, failure, node-label, and 390 px overflow checks. REAL passes one completed native OpenCode tool with result evidence and `mac-mini` attribution, plus zero replay duplicates after restart. |
| EXEC-07 | M2 | Done | ACP proves fake node/workspace/hostname evidence; REAL verifies OpenCode `mac-mini` reply identity, origin linkage, exact workspace file content, and no unexpected task artifacts elsewhere in the isolated acceptance root. Physical-node evidence remains under M4. |

## Teams and coordination

| ID | Milestone | Status | Acceptance evidence |
|---|---|---|---|
| TEAM-01 | M3 | Planned | Create/edit/delete a team and verify team mentions reach only enabled members. |
| TEAM-02 | M3 | Planned | Scripted cross-agent delegation must preserve origin, room, node, routing, and depth limits. |
| TEAM-03 | M3 | Planned | Shared task state and synthesized results must survive restart and appear once in the originating room. |
| TEAM-04 | M3 | Planned | Force a cross-node delegation chain and prove the global budget stops it without transport-event consumption. |

## Files

| ID | Milestone | Status | Acceptance evidence |
|---|---|---|---|
| FILE-01 | M2 | Done | FILE passes exact content/SHA-256 checks, identical retry deduplication, receipt conflicts, type/size/path/content rejection, aborted-transfer cleanup, room/message binding, identical Mini/remote-Dell byte delivery, restart-safe downloads, delayed-upload deletion blocking, aborted-upload guard release, legacy defaults, and deletion cleanup without orphaned metadata or bytes. UI passes real file-input upload, status/hash chips, room locking, message metadata, exact downloads and agent bytes, and 390 px overflow checks. REAL passes real OpenCode embedded-resource delivery with the marker absent from instruction text, exact native file output, UUID-only central storage, and same-session recall after restart. |
| FILE-02 | M2 | Next | Return and preview generated files across local and remote paths with size/hash verification. |

## Execution nodes

| ID | Milestone | Status | Acceptance evidence |
|---|---|---|---|
| NODE-01 | M0 | Done | ACP proves authenticated round trip and invalid-credential rejection before harness startup. |
| NODE-02 | M4 | Planned | Run host-specific sentinel and workspace tests on the physical Dell; no Mini execution fallback. |
| NODE-03 | M4 | Planned | Repeat identity, session, workspace, and reconnect acceptance on MacBook and one future-node configuration. |
| NODE-04 | M4 | Partial | ACP proves selected remote workspace and no central proof files; traversal, absolute-path, and symlink escapes remain. |

## Phone experience

| ID | Milestone | Status | Acceptance evidence |
|---|---|---|---|
| MOBILE-01 | M0 | Done | UI passes 390 px chat, room/agent drawers, mentions, attachment upload/status/download, management forms, and horizontal-overflow checks. |
| MOBILE-02 | M4 | Planned | Physical phone opens the same room over authenticated private connectivity; no vendor account or second chat app. |
| MOBILE-03 | M4 | Planned | Install, background/foreground, switch Wi-Fi/cellular, and reconnect without duplicate messages or turns. |

## Security and operations

| ID | Milestone | Status | Acceptance evidence |
|---|---|---|---|
| SEC-01 | M5 | Partial | APP rejects foreign Origin/Host and non-JSON mutations before execution; server defaults to loopback and contains no commerce/analytics flows. Actual egress and permission review remain. |
| SEC-02 | M4 | Planned | Unauthenticated/wrong-identity requests fail before any non-loopback exposure; authorized phone access succeeds. Remote-ACP raw TCP must use protected Tailscale or TLS before physical deployment. |
| SEC-03 | M5 | Partial | SUP proves fake provider stderr is redacted from health, messages, execution errors, and persisted state; REAL inspects the persisted registry. Demo tokens use owner-only Git-ignored files; complete storage, rotation, and log review remains. |
| OPS-01 | M0 | Done | SVC restart recovered health and preserved one room, two agents, six existing messages, zero executions, and zero attachments on 2026-11-04; attachment metadata and 8 MiB/four-file limits remained intact, and no test conversation was added. |
| OPS-02 | M5 | Planned | Back up and restore Hub, sessions, registry, and node configuration into an isolated acceptance instance. |
| OPS-03 | M5 | Planned | Rotate/revoke credentials and remove a node without unauthorized access or unrelated-agent disruption. |
| OPS-04 | M5 | Planned | Inventory egress and permissions; verify blocked optional destinations do not break accepted workflows. |

## Follow-on requirements

| ID | Milestone | Status | Acceptance evidence |
|---|---|---|---|
| EXP-01 | Post-V1 | Planned | Prioritize only after observed daily-use needs; define search/notification acceptance separately. |
| EXP-02 | Post-V1 | Planned | Schedule only after execution recovery and duplicate-prevention gates pass. |

## Current release conclusion

OpenBot Hub is a verified local application with M1 supervision complete and M2 active, not full-feature V1. All 25 offline tests pass, desktop and 390 px browser acceptance passes, and one real OpenCode adapter has passed five supervision calls plus the separate two-call file/session gate, covering native file and embedded-resource attachment delivery, identity, lifecycle, session resume, completed real tool progress with no replay duplicates, detailed permission, genuine form-question, stop/failure supervision, and descendant cleanup. FILE-01 is Done; FILE-02 generated-file return and the complete M2 exit gate remain open. Physical devices, other real harnesses, and production readiness must not be inferred from this local adapter or phone-sized-browser evidence.
