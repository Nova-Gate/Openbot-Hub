# OpenBot Hub

A private, account-free coordination app for Mo's agents across machines and harnesses.

## What this is

OpenBot Hub is a custom local web application inspired by OpenBot's agent and ACP architecture. It does **not** install or launch upstream OpenBot and does not require email verification, a vendor account, hosted services, payment, billing, analytics, or telemetry.

One responsive application provides the global **Army** room plus focused project rooms. Agents keep their execution identity and run on their assigned machine: local agents connect directly, while remote agents use an authenticated ACP execution-node connector. The same interface works in desktop and phone browsers.

## Run the working proof of concept

Requirements: Node.js 22 or newer. There are no package dependencies or API keys to install.

```sh
cd /Users/immortalist/Documents/Kimi/Workspaces/MacServer/openbot-hub
npm run dev
```

Open `http://127.0.0.1:7100/`.

The launcher starts the web application and a demo execution node. The initial registry includes:

- **Mini Fake** — a local deterministic agent tagged `mac-mini`.
- **Dell Fake** — an agent reached through the authenticated remote-ACP connector and tagged `demo-dell`.

Send `@Mini Fake hello`, `@Dell Fake hello`, or `@everyone status`. Replies appear in the shared room with their execution-node tags. Messages, rooms, agent definitions, sessions, and execution evidence persist under the ignored `runtime/` directory.

The demo Dell node currently runs on this Mac. It proves connector and execution separation, **not physical Dell execution**.

## Persistent Mac service

OpenBot Hub is installed as the user LaunchAgent `com.molaoshi.openbot-hub`. It starts at login, restarts after failure, and serves `http://127.0.0.1:7100/` using `/opt/homebrew/bin/node`. Its configuration is stored at `~/Library/LaunchAgents/com.molaoshi.openbot-hub.plist`.

```sh
# Restart after code or configuration changes
launchctl kickstart -k "gui/$(id -u)/com.molaoshi.openbot-hub"

# Stop the service
launchctl bootout "gui/$(id -u)/com.molaoshi.openbot-hub"

# Start it again after stopping
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.molaoshi.openbot-hub.plist
```

Service logs are written to `runtime/openbot-hub.out.log` and `runtime/openbot-hub.error.log`.

## Manage agents, rooms, and execution

- Select **+ ADD** in the execution directory to register a local-fake, OpenCode, or remote-ACP agent.
- For **OpenCode · real ACP**, provide the full `opencode-cli` path and a disposable workspace. The Hub launches `opencode-cli acp`; it does not install upstream OpenBot or ask for an OpenBot account.
- Use **TEST** to check connectivity and expose available, unavailable, misconfigured, disabled, or untested health.
- Use an agent's pencil control to edit its identity, connection, workspace, color, or enabled state. Execution changes invalidate the saved session reference.
- Disabled agents cannot execute. Removing an agent preserves its message history.
- Select **+ NEW** in the room panel to create a project room and choose its members.
- Use the header pencil to rename a project room, edit its purpose or membership, or delete its history with confirmation. Army permits purpose edits only.
- Execution cards show queued, running, waiting, completed, failed, interrupted, and unknown states. Stop queued/active work or retry only known-safe pre-execution failures.
- Harness questions and permission requests appear on their execution card. Approving or rejecting returns the decision to the same native session; expiry, stopping, and restart leave explicit terminal records rather than pending work.
- Execution cards show live plans and tool calls with pending/completed states, commands, paths, content, raw output, timestamps, and authoritative node labels. Tool updates coalesce into one durable operation and transcript replay is excluded.
- Use the paperclip to attach up to four TXT, MD, CSV, JSON, PDF, PNG, or JPEG files, at most 8 MiB each. Uploads are room-bound, SHA-256 verified, sent as ACP content rather than central paths, and downloadable from the message. Room switching locks while attachments are selected and Send waits for every upload.
- The Army room always includes every enabled agent. In project rooms, `@everyone` includes only enabled members.

Remote-ACP registration references a connector config file; connector tokens remain in separate owner-only files. OpenCode uses its own existing provider profile. Neither connector credentials nor provider credentials are entered into the agent registry, prompts, message history, or Git.

## Real OpenCode acceptance

The separate live acceptance commands use the installed OpenCode CLI and its existing provider authentication. The base gate makes two small real model calls, uploads a random marker as an embedded text resource while keeping it out of the instruction text, requires OpenCode to read that attachment and create an exactly matching native file in a disposable workspace, checks completed real tool evidence and `mac-mini` attribution, restarts the Hub, verifies native session recall with zero replayed progress duplicates, and removes the disposable directory. The supervision gate makes five small calls and proves native permission approval with complete operation details, a real OpenCode form question answered through `elicitation/create`, active stop and descendant cleanup, provider-crash failure and cleanup, and successful recovery in the same native session.

```sh
npm run test:opencode
npm run test:opencode-supervision
# Override the CLI location when needed:
OPENCODE_CLI=/full/path/to/opencode-cli npm run test:opencode-supervision
```

On this Mac, the default CLI is `~/Library/Application Support/ai.opencode.desktop/cli/2.0.26/opencode-cli`. Live tests are intentionally separate from offline `npm test`; reports are written under `artifacts/opencode-acceptance/` and `artifacts/opencode-supervision/`.

## Verify

```sh
npm run check
npm test
npm run test:ui  # macOS + Google Chrome
npm run test:opencode  # real provider calls; separate live gate
npm run test:opencode-supervision  # five-call real supervision gate
```

The offline suite contains 25 tests covering remote ACP execution, workspace proof, session resume, credential rejection, connectivity health, OpenCode registration validation, concurrent idempotency, per-agent queue order, queued/active stop, process-group cleanup, known-safe retry, unknown-outcome recovery, room lifecycle safeguards, and persistence across restart. Attachment coverage includes exact content and SHA-256 verification, retry deduplication/conflicts, type/size/path/content rejection, aborted transfer cleanup, room/message binding, identical Mini/Dell byte delivery, restart-safe downloads, delayed-upload/deletion race protection, and deletion cleanup. Progress coverage includes tool/plan normalization, secret redaction, pending-to-completed coalescing, raw output, authoritative Mini/Dell node attribution, restart persistence, and legacy execution loading. Approval coverage includes native `elicitation/create` questions with structured accept/decline/cancel outcomes, enforced string patterns, decimal number submission, complete/redacted permission operation details, wrong-session rejection, invalid and repeated decisions, expiry, waiting stop, active-modification guards, restart recovery, and the persistence-decision race. Hardening regressions also cover nonexistent executables, foreign Origin/Host requests, non-JSON mutations, malformed-state preservation, unique workspaces, and provider-stderr redaction. GitHub Actions runs syntax and offline tests for every PR and push to `main`; browser and live provider acceptance remain local gates.

## Product plan

- [Product requirements](docs/product-requirements.md) — authoritative scope and V1 definition.
- [Delivery roadmap](docs/migration-plan.md) — milestone order and exit gates.
- [Requirements matrix](docs/requirements-matrix.md) — status and acceptance evidence for every requirement.
- [Testing instructions](docs/TESTING.md) — manual checks and current limitations.

**M1 is complete. M2 is active:** the real OpenCode adapter, native file/session acceptance, real-agent stop/failure supervision, room-bound native questions and detailed approvals, rich tool/plan progress, and deliberate attachments have landed; generated-file return and the remaining M2 exit gate are still open. Feature changes must reference requirement IDs and update the matrix.

## Source layout

```text
server/                  Account-free Hub, registry, rooms, web server, SSE, runtime
web/                     Responsive multi-room chat and management interface
connectors/remote-acp/   Authenticated remote execution connector and fake harness
config/                  Demo-only, non-secret agent and node configuration
scripts/                 Development launcher and real OpenCode acceptance
tests/                   Offline protocol and application integration tests
docs/                    Architecture and acceptance plans
```

## Boundaries

- Army Hub is a separate repository and is not modified by this project.
- The server listens on loopback by default. Do not expose it to a network without adding access control.
- OpenCode is the first real adapter. DSH, Hermes, and Grok adapters are not implemented yet.
- The disposable acceptance checks task artifacts within its isolated test root; it is not an operating-system sandbox and does not restrict OpenCode's own session/profile storage.
- Physical Dell/MacBook enrollment and secure phone access remain deployment work.
- Upstream OpenBot code is not bundled in the runnable app. Any future copied or modified upstream code must retain its PolyForm Noncommercial 1.0.0 notices.

GitHub remote: `https://github.com/Nova-Gate/Openbot-Hub.git`. The repository-local credential helper uses the `github-pat-open-bot-hub` macOS Keychain entry; tokens and runtime files remain ignored.
