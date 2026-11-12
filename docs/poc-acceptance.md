# Proof-of-concept acceptance tests

## Status

The local proof of concept has passed automated connector and web-application integration tests, plus desktop and 390 px mobile browser checks. These cover portions of ACP-02/03/04/06/07/08, TEAM-01/02, MOBILE-04, and the responsive interface using fake agents on one physical Mac. Deliberate attachment upload, integrity, local/remote byte delivery, verified download, deletion cleanup, and mobile-width composition have also passed. Separate disposable acceptance gates have passed for real local OpenCode native files, embedded-resource attachment delivery, durable sessions, detailed native permission approval, a real `elicitation/create` form question, active stop, induced provider failure, descendant cleanup, and same-session recovery.

Physical multi-machine execution, secure phone-network access, generated-file return, delegation, and production security remain pending or only partially covered. Real OpenCode evidence does not establish acceptance for other harnesses or physical nodes. This document remains the evidence checklist for the full gates.

## Evidence rules

For every run, record:

- Test ID, date, Git commit, OpenBot Hub version, connector version, and harness version.
- Control-plane node and execution node.
- OpenBot Hub agent ID, connector session ID, harness session ID, origin ID, and delivery ID.
- Actions performed and observed result.
- Relevant redacted logs and protocol events.
- Pass/fail and any manual steps required.

Never include provider tokens, connector credentials, session bearer tokens, private repository contents, or unredacted sensitive prompts in evidence.

Store local run artifacts outside Git by default. Commit only redacted summaries when needed.

## ACP — Remote execution protocol

### ACP-01: Registration and discovery

**Setup:** One fake Dell harness exposed through the connector and registered as one custom ACP agent on Mini.

**Steps:** Start OpenBot Hub and the connector; list and select the agent.

**Pass:** The agent appears once, maps to Dell, and no Mini-local executable with the same agent identity is started.

### ACP-02: New session and prompt round trip

**Steps:** Start a new conversation and send a scripted prompt with a known origin ID.

**Pass:** Exactly one Dell harness session is created; the expected streamed/final answer returns to the same OpenBot Hub conversation with matching origin and delivery IDs.

### ACP-03: Session persistence and resume

**Steps:** Complete a turn, disconnect/reconnect the connector, then resume the same conversation. Repeat after OpenBot Hub restart.

**Pass:** The same logical harness session is resumed, prior context remains available, and no duplicate session or turn is created.

### ACP-04: Execution-location proof

**Steps:** Ask the fake harness to write a unique sentinel and report its hostname and workspace.

**Pass:** The sentinel exists only in the intended Dell workspace; Dell process/host evidence matches; no corresponding Mini path or process is created.

### ACP-05: Workspace and path containment

**Steps:** Attempt normal file access, a relative traversal, an absolute Mini-style path, and a symlink escape.

**Pass:** Normal access occurs remotely; every escape fails closed; no Mini path fallback occurs.

### ACP-06: Queueing and idempotent retry

**Steps:** Queue multiple prompts; retry a request with the same origin/idempotency key after a simulated lost response.

**Pass:** Ordering is deterministic, the retry returns the original receipt/result where applicable, and only one execution occurs.

### ACP-07: Cancellation and interruption

**Steps:** Start a long fake turn, stop it, then send another prompt.

**Pass:** The remote work is interrupted, the visible state is accurate, resources are released, and later work proceeds without creating a parallel unintended session.

### ACP-08: Questions and approvals

**Steps:** Trigger a scripted question and an approval; answer from OpenBot Hub.

**Pass:** The correct pending request appears once, the response reaches the originating Dell session, and the turn resumes with that answer. Expired or wrong-session handles are rejected.

### ACP-09: Attachments and generated files

**Steps:** Send a known attachment; return a generated file; verify sizes and hashes. Repeat with oversized and interrupted transfers.

**Pass:** Content and hashes match, ownership is correct, interrupted transfers do not appear complete, and size limits fail cleanly.

### ACP-10: Restart during active work

**Steps:** Restart the connector during a turn; repeat with OpenBot Hub restart and node network interruption.

**Pass:** Each turn is reconciled as completed, failed, interrupted, or unknown. Unknown outcomes are not blindly retried and require attention.

### ACP-11: Duplicate events and acknowledgement storms

**Steps:** Inject duplicate protocol events, repeated receipts, and repeated final responses.

**Pass:** Duplicates are suppressed, no agent-to-agent acknowledgement loop starts, and transport events do not consume the global agent-turn budget.

### ACP-12: Capability mismatch

**Steps:** Advertise unsupported or partial ACP capabilities.

**Pass:** Unsupported behavior is hidden or fails explicitly before work starts; the connector never pretends that an unsupported operation succeeded.

## TEAM — One global Army channel

### TEAM-01: Three nodes in one conversation

**Setup:** Fake agents on Mini, Dell, and MacBook in one channel.

**Pass:** Mo sees and addresses all three from one channel with no host switching or second application; execution-location evidence is correct for each.

### TEAM-02: Direct mention and multi-mention

**Steps:** Address one agent, then two agents, in separate requests.

**Pass:** Only selected agents execute; multi-agent replies remain associated with the original request and correct authors.

### TEAM-03: Delegation and result synthesis

**Steps:** Have one agent delegate a scripted subtask to a remote teammate and incorporate its result.

**Pass:** Delegation crosses nodes correctly, the requester receives the result, and the final synthesis appears in the same global thread.

### TEAM-04: Global anti-loop budget

**Steps:** Force repeated agent-generated follow-ups across nodes.

**Pass:** The global budget stops the chain at the configured limit; a human message starts a new task budget; transport retries do not consume turns.

### TEAM-05: Node offline isolation

**Steps:** Take Dell offline while Mini and MacBook agents remain available.

**Pass:** Dell work shows an accurate pending/failed state; other agents continue; recovery does not duplicate Dell work.

### TEAM-06: Concurrent workspaces

**Steps:** Run agents with the same workspace key on different nodes and agents with different workspaces on one node.

**Pass:** Files and side effects remain correctly isolated by agent and node; no accidental shared state occurs.

## MOBILE — OpenBot Hub-only phone experience

### MOBILE-01: Pair and open the global channel

**Pass:** The phone pairs to the Mini control plane and opens the same global Army channel and membership seen on desktop.

### MOBILE-02: Cross-network reconnect

**Steps:** Move between Wi-Fi and cellular, background/foreground the app, and temporarily suspend the host connection.

**Pass:** The channel reconnects, history remains coherent, and sending resumes without duplicate messages.

### MOBILE-03: Send and receive cross-node work

**Pass:** A phone-originated request reaches agents on at least two machines and their replies appear in the original global thread.

### MOBILE-04: Approval, question, and stop

**Pass:** The phone can answer supported prompts, review full approval details, stop work, and observe accurate final state. Unsupported secret/browser interactions fail with clear directions rather than silent success.

### MOBILE-05: Attachments and files

**Pass:** Supported attachments and generated files transfer correctly within mobile limits; failures are visible and retry-safe.

### MOBILE-06: Single-app check

**Pass:** All required daily global-chat and coordination actions are possible in OpenBot Hub without Element, a browser fallback to another chat client, or host switching.

## REAL — Disposable real-agent onboarding

Run these separately for every real harness/agent.

### REAL-01: Identity and credential isolation

**Pass:** The agent uses only its intended identity and node-local credentials; secrets are absent from logs, prompts, Git, and other agents' environments.

### REAL-02: Native tool execution location

**Pass:** Representative filesystem, shell, and harness-specific tools demonstrably execute on the assigned node.

### REAL-03: Real session continuity

**Pass:** A real conversation resumes correctly after client, connector, and harness restart according to the harness's documented capabilities.

### REAL-04: Safe workspace behavior

**Pass:** The agent can perform intended work in its disposable workspace and cannot escape its approved boundary.

### REAL-05: GitHub disposable workflow

**Pass:** In a disposable repository, the agent can follow the required issue/branch/change/verify/PR workflow and post the correct evidence without accessing unrelated repositories.

### REAL-06: Failure and usage-limit behavior

**Pass:** Provider errors, authentication failure, and usage limits produce accurate state and do not cause retry storms or silent provider/account switching.

## SEC — Security and permission verification

### SEC-01: Default permission posture

**Pass:** Actual OpenBot Hub and harness permissions are documented from observed behavior, including whether actions require approval. No assumption is made from marketing or inconsistent documentation.

### SEC-02: Node authorization

**Pass:** A node credential can reach only its assigned agents and operations; revoked credentials fail promptly; one node cannot impersonate another.

### SEC-03: Local script/API exposure

**Pass:** No loopback automation or Team API listener is exposed directly to Tailscale or the LAN without an authenticated intended adapter.

### SEC-04: Secret handling

**Pass:** Secret stores have appropriate OS permissions; logs and diagnostics are redacted; connector and provider credentials never enter model context.

### SEC-05: Remote tool opt-in

**Pass:** Browser, computer-use, host-global MCP, and privileged tools are disabled for remote agents until each has an explicit execution-location and authorization test.

## EGRESS — Commerce, reporting, and telemetry removal

### EGRESS-01: Product analytics disabled

**Pass:** Desktop/host, website, and mobile produce no OpenPanel or equivalent analytics requests, including startup, account, foreground, reconnect, and error paths.

### EGRESS-02: Commerce and hosted services disabled

**Pass:** No Stripe, billing, hosted-server, hosted-site, abuse-reporting, or unwanted marketplace flows are reachable or required for normal operation.

### EGRESS-03: Expected network inventory

**Pass:** All remaining destinations are enumerated and categorized: account/Signal/TURN, application/provider updates, model providers, explicitly enabled plugins, and user-directed browsing.

### EGRESS-04: Offline/local failure behavior

**Pass:** Blocking optional telemetry, commerce, marketplace, and update destinations does not break accepted chat and execution flows.

## Final go/no-go scenario

From the phone, in OpenBot Hub alone:

1. Open the single global Army channel.
2. Ask a Mini agent and Dell agent to coordinate on one task.
3. Approve a safe operation when requested.
4. Confirm execution-location evidence for both agents.
5. Background the phone and restart the Dell connector.
6. Return to the same thread and verify one coherent result with no duplicate turn.

The architecture is viable only when this scenario passes with no Element session, no host switch, no manual connector repair, and no hidden Mini execution substituting for Dell work.
