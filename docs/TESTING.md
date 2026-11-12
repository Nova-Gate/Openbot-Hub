# Testing OpenBot Hub

## What is implemented

The repository contains a runnable, account-free application with:

- A global Army room and member-scoped project rooms.
- A persistent agent registry with add, edit, disable, re-enable, and remove controls.
- Deterministic local-fake and authenticated remote-ACP execution.
- A real local OpenCode ACP adapter with configurable CLI and workspace paths, native file tools, and durable native sessions.
- Live updates over server-sent events.
- Node identity on every agent reply.
- Workspace selection and execution-proof evidence.
- Idempotent client message posting.
- Persistent per-recipient execution records with lifecycle history, result links, and bounded durable tool/plan events.
- Execution cards with live pending/completed tool calls, plan steps, commands, paths, content, raw output, failure text, and authoritative node labels.
- Execution cards with queued/active/waiting stop and known-safe retry controls.
- In-room native form questions and permission choices with persistent pending/terminal approval records and same-session resume.
- Full command, raw-input, path/location, content, and diff details rendered safely as text before permission decisions.
- Connectivity checks with available, unavailable, misconfigured, disabled, and untested health.
- Room rename, purpose/membership editing, and confirmed deletion in the UI and API.
- Deterministic slow, fail-once, rich progress, native question, detailed approval, and wrong-session fake work for supervision acceptance.
- Deliberate TXT, MD, CSV, JSON, PDF, PNG, and JPEG attachments with four-file/8 MiB limits, room binding, UUID storage, SHA-256 verification, ACP byte delivery, message downloads, and deletion cleanup.
- Offline connector/application integration tests and separate live OpenCode file/session and supervision acceptance scripts.

The offline demo and test suite require no upstream OpenBot installation, email address, vendor account, API key, model provider, or paid API call. The optional real OpenCode tests use the CLI's existing provider authentication and make small model calls; they do not use an OpenBot account or copy provider credentials into the Hub.

## Run automated checks

```sh
cd /Users/immortalist/Documents/Kimi/Workspaces/MacServer/openbot-hub
npm run check
npm test
npm run test:ui  # requires macOS and Google Chrome
npm run test:opencode  # live file/session gate; two small model calls
npm run test:opencode-supervision  # live question/approval/stop/failure gate; five model calls
```

The browser command starts an isolated temporary server on a random port, uses separate runtime state, exercises the real file input through Chrome, verifies attachment chips, room locking, message metadata, exact downloads, agent-received bytes, and 390 px layout, then covers pending/completed progress, command/output, plans, failures, visible permission details, and native question accept/decline flows. It writes screenshots and a report under `artifacts/ui-validation/` and stops its temporary processes. It does not replace the persistent service or modify its state. GitHub Actions runs `npm run check` and `npm test` for every pull request and push to `main`; browser and live provider tests remain local acceptance gates.

The integration tests verify:

- ACP initialization, prompt responses, and execution in the node workspace.
- Durable session reload after a proxy restart.
- Rejection of an invalid connector credential.
- Account-free health and room state APIs.
- Replies from both `mac-mini` and `demo-dell` agents.
- Project-room membership and room-scoped `@everyone` routing before and after membership replacement.
- Room rename and purpose editing, duplicate-name and length validation, and Army update/delete protections.
- Confirmed disposable-room deletion with message, execution, and idempotency-receipt cleanup.
- Persisted queued → running → completed execution history and reply-message links.
- Tool/plan normalization and redaction, pending-to-completed coalescing, preserved raw input/output, authoritative Mini/Dell node labels, event persistence across restart, and legacy executions without event arrays.
- Available, unavailable, misconfigured, disabled, and untested connectivity health.
- Explicit, unique OpenCode workspaces and non-secret registration/configuration preservation.
- Two nonexistent-CLI connectivity attempts returning `misconfigured` without terminating the Hub.
- Foreign Origin and Host headers rejected before execution, non-JSON mutations rejected, and same-origin JSON work still accepted.
- Malformed state aborting startup while leaving the original bytes unchanged; valid state creates a load backup before recovery writes.
- Fake provider secrets in stderr redacted from health, execution errors, room messages, and persisted state.
- Five concurrent posts with one idempotency key producing one message and one execution.
- Per-agent queue ordering, including work that remains queued behind a slow turn.
- Queued and active fake stop with no stopped reply, resource cleanup, and successful subsequent work.
- ACP process-group cleanup and rejection of the in-flight prompt when active work stops.
- One known-safe fail-once retry with attempt linkage; interrupted and unknown outcomes cannot be retried.
- Native `elicitation/create` form questions and permission decisions round-trip through `waiting → running`, with structured accept, decline, and cancel outcomes and no repeated decisions.
- Backend rejection of `INVALID123` against `^[a-z]+$`, plus browser submission of decimal `0.5` through a non-integer number input with `step="any"` and no step mismatch.
- Complete permission command, raw-input, path/location, content, and diff preservation with redaction and safe-text rendering.
- The exact persistence race where an approved decision previously could be returned to ACP as cancelled.
- Waiting stop, wrong-session rejection, approval expiry, active-agent modification guards, and safe restart recovery without pending work or automatic reruns.
- Non-global room deletion blocked while its execution is active.
- Unfinished executions recovered as `unknown` after restart without automatic reruns or extra messages; pending approvals become `interrupted`.
- Agent creation, renaming, disabling, re-enabling, session resume, and removal.
- Preservation of message history after agent removal.
- Duplicate-name rejection and unknown-room/member validation.
- No duplicate message or execution when a `clientMessageId` is repeated.
- Attachment content and SHA-256 verification, identical retry deduplication, conflicting-receipt rejection, type/size/path/content rejection, and aborted-transfer cleanup.
- Room-bound, single-message attachment use, identical bytes delivered to Mini and remote Dell workspaces, and verified downloads after restart.
- Room deletion blocked during a delayed upload, successful deletion after settlement, and aborted transfers releasing the deletion guard without orphaned metadata or bytes.
- Legacy-state attachment defaults and room deletion removing attachment metadata, receipts, and stored files.
- Registry, room, conversation, execution, approval, attachment, and session persistence after an application restart.

## Real OpenCode acceptance

Set `OPENCODE_CLI=/full/path/to/opencode-cli` when the installed CLI differs from this Mac's default `~/Library/Application Support/ai.opencode.desktop/cli/2.0.26/opencode-cli`. Both scripts create isolated roots under ignored `.runtime/`, start the actual Hub API with one `local-opencode` agent, stop temporary app processes, and remove their disposable roots. Evidence covers task artifacts inside each isolated acceptance root; it is not an operating-system sandbox and does not prohibit OpenCode's own provider profile or native session storage elsewhere.

### Files and durable sessions

Run `npm run test:opencode`. This makes two small model calls and verifies:

1. Connectivity through real ACP initialization.
2. A random marker is uploaded as `source.txt`, kept out of the instruction text, and delivered to OpenCode as an ACP embedded text resource. Central storage uses only the attachment UUID, not a Mini path in the prompt.
3. A small live task reads that resource and creates `evidence.txt` with the exact random token and no additional workspace files.
4. The reply and execution retain Army-room, origin, agent, and `mac-mini` identity with queued → running → completed history.
5. A real OpenCode tool reaches `completed` with operation result evidence, `evidence.txt` details, and authoritative `mac-mini` attribution.
6. No unexpected task artifacts appear in the control directory outside the disposable workspace, and an outside guard file remains unchanged.
7. The registry definition contains no provider credential fields.
8. After a full Hub restart, OpenCode loads the same native session and recalls the token without rereading the file; the no-tool turn contains zero replayed progress events.

The JSON report is written to `artifacts/opencode-acceptance/report.json`.

### Questions, approvals, stop, failure, and recovery

Run `npm run test:opencode-supervision`. This makes five small model calls against a disposable OpenCode workspace whose bash permission is `ask`, and verifies:

1. A native OpenCode permission request becomes one room-bound pending approval; allow-once resumes the same execution through `queued → running → waiting → running → completed`, preserves the real command details, and produces the requested file.
2. A genuine OpenCode `elicitation/create` form question becomes a native room question and resumes with the structured answer `npm`.
3. Stopping active real work marks it `interrupted` and cleans up the tool descendant process.
4. An induced provider-process crash marks active work `failed`, not retry-safe, and cleans up its tool descendant process.
5. A subsequent execution completes and recalls the original token through the same durable native OpenCode session.

The JSON report is written to `artifacts/opencode-supervision/report.json`.

## Run the app

```sh
cd /Users/immortalist/Documents/Kimi/Workspaces/MacServer/openbot-hub
npm run dev -- --host 127.0.0.1 --port 7100
```

Open `http://127.0.0.1:7100/`. Stop the app with Ctrl+C when finished.

The launcher creates demo-only state under `runtime/`, generates a local connector credential if needed, starts the fake execution node, and then starts the web application. It never launches upstream OpenBot or touches Army Hub. Real OpenCode agents are registered separately through the execution directory and launch only when tested or addressed.

## Manual acceptance flow

### Chat

1. Confirm the page shows the **Army** room and two initial agents, with no sign-in or onboarding.
2. Send `@Mini Fake hello` and expect a reply tagged `MAC-MINI`.
3. Send `@Dell Fake hello` and expect a reply tagged `DEMO-DELL`.
4. Send `@everyone status` and expect one reply from each enabled agent.

### Agent registry

1. Select **TEST** beside Mini Fake and confirm its health becomes **AVAILABLE**.
2. Select **+ ADD**, create a local-fake agent, and confirm it appears in the directory and Army mention chips.
3. Mention the new agent and confirm its reply and node identity.
4. Edit its name and color, disable it, and confirm it cannot be addressed for execution and shows **DISABLED**.
5. Re-enable it and send another message; its saved session should resume.
6. Remove it and confirm its previous messages remain in the conversation.
7. Restart the app and confirm registry changes persist.
8. Open **+ ADD**, choose **OpenCode · real ACP**, and confirm only the CLI path and OpenCode workspace are additionally required. Use a full CLI path and a disposable workspace for a real agent.
9. While an agent has queued, running, or waiting work, confirm its edit and remove actions are blocked until that work reaches a terminal state.

### Execution supervision and approvals

1. Send `@Mini Fake slow:5000 test stop`; its execution card should become **RUNNING**.
2. Send another Mini prompt while the slow turn is active; the second card should remain **QUEUED**. Stop it and confirm it becomes **INTERRUPTED** without a reply.
3. Stop the active slow turn, confirm it becomes **INTERRUPTED**, then send a normal prompt and confirm the agent still executes.
4. Send `@Mini Fake fail-once safe retry`. The first attempt should fail before execution and offer **Safe retry**.
5. Select **Safe retry** and confirm a linked attempt 2 completes. The old retry button should disappear; interrupted or unknown records never offer retry.
6. Send `@Mini Fake progress slow:5000 rich progress`. While running, confirm one pending tool and one in-progress plan show the command and `mac-mini`. After completion, confirm the same tool entry shows `completed`, raw stdout and exit code, the plan steps complete, and no duplicate tool or plan cards appear. Restart and confirm those events persist.
7. Send `@Mini Fake question before continuing`. Confirm the execution becomes **WAITING** and a native form appears. Change the package manager to `npm`, submit the structured answer, and confirm it resumes and completes with the terminal answer visible. Repeat with **Decline** and **Cancel** and confirm those outcomes are explicit.
8. Send `@Mini Fake approval before continuing`. Before deciding, confirm the full command, raw input, path/location, content, and diff appear as readable text. Reject the request and confirm the same execution resumes and the reply records the rejection.
9. Send another approval prompt and stop it while waiting. Confirm the execution becomes **INTERRUPTED**, the approval can no longer be decided, and a later normal prompt succeeds.

### Deliberate attachments

1. Use the paperclip to select a small TXT file. Confirm an upload status chip appears, room switching locks while it is selected, and Send remains disabled until the upload finishes.
2. Confirm the completed chip shows the filename, size, and SHA-256 prefix. Send `@Mini Fake attachment check` with the file and confirm the message shows its public metadata and a safe download link.
3. Download the attachment and compare it byte-for-byte with the original. Inspect `runtime/hub/mini-workspace/received-attachments/<attachment-uuid>` and confirm the fake agent received identical bytes under the UUID filename.
4. Repeat with `@Dell Fake attachment check`; confirm identical bytes under that remote demo agent's own workspace rather than a central Mini path.
5. Restart the Hub and confirm the message metadata and exact download still work. Delete a disposable room containing an attachment and confirm its metadata, receipt, and stored file are removed.
6. At 390 px, repeat selection, upload, send, and download; confirm chips and links remain usable without horizontal overflow.

### Rooms and phone

1. Select **+ NEW**, create a room with only one agent member, and confirm it becomes active.
2. Send `@everyone status`; only the enabled room member should execute.
3. Use the header pencil to rename the room, edit its purpose, and change membership; confirm the mention chips update.
4. Reopen the room editor and delete the room with confirmation. Confirm the app returns to Army and the room history is removed.
5. Open Army's editor and confirm its name and membership are locked and deletion is unavailable; its purpose remains editable.
6. Switch between Army and a project room and confirm their transcripts remain separate.
7. At a narrow viewport, open and close the room and agent drawers.
8. Open the agent form at phone width and confirm its fields and actions fit the viewport.
9. At phone width, inspect a completed progress card, submit one native question, reject another approval, and send/download an attachment; confirm raw output, plan steps, full operation details, structured choices, attachment chips/links, and resulting execution states remain usable without horizontal overflow.

Fake execution evidence is written beneath the agent's configured workspace. Initial demo paths include:

```text
runtime/hub/mini-workspace/
runtime/demo/dell-workspace/dell-fake/
```

Each fake workspace contains `execution-proof.json`, `last-prompt.txt`, and `events.jsonl` after execution; received attachment bytes appear under its `received-attachments/` directory. Real OpenCode evidence consists of native task artifacts in its configured workspace plus the Hub's durable execution, progress, approval, attachment metadata, and session records.

## Current limitations

- The node named `demo-dell` runs on the current Mac. It proves transport and execution separation, not execution on the physical Dell.
- OpenCode is the only real adapter. DSH, Hermes, and Grok adapters are not implemented.
- Reusable teams, agent-to-agent delegation, generated-file return, and remote tool arbitration are not implemented.
- Safe retry is limited to explicit pre-execution failures; interrupted and unknown outcomes require reconciliation rather than automatic resubmission. Real OpenCode active stop, descendant cleanup, one induced provider crash, and subsequent same-session recovery have passed the dedicated acceptance gate; broader provider, authentication, and usage-limit failures still require coverage.
- OpenCode workspace acceptance is not an OS-level sandbox. Broader permission mediation and containment remain security work.
- The remote-ACP demo uses authenticated raw TCP on loopback. Physical-machine deployment requires protected Tailscale transport or TLS and explicit binding rules in M4.
- The server is loopback-only by default and has no network user authentication. Tailscale/phone exposure requires an access-control design first.
- This is a development proof of concept, not a production-hardened deployment.
