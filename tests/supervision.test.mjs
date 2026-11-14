import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = resolve(root, "server/server.mjs");

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function startApp(directory) {
  const child = spawn(process.execPath, [
    serverScript,
    "--host", "127.0.0.1",
    "--port", "0",
    "--state", join(directory, "hub-state.json"),
    "--agents", join(directory, "agents.json"),
    "--shutdown-grace-ms", "1000",
    "--shutdown-deadline-ms", "8000",
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  const ready = await withTimeout((async () => {
    for (;;) {
      const line = stdout.split("\n").find((value) => value.includes("openbot-hub.ready"));
      if (line) return JSON.parse(line);
      if (child.exitCode !== null) throw new Error(`App exited: ${stderr}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  })(), 5_000, `App startup timed out: ${stderr}`);
  return { child, base: new URL(ready.url) };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await withTimeout(exited, 5_000, "Process shutdown timed out");
}

async function request(app, path, options) {
  const response = await fetch(new URL(path, app.base), options);
  const value = await response.json();
  assert.ok(response.ok, `${path} returned ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

async function requestError(app, path, options, status) {
  const response = await fetch(new URL(path, app.base), options);
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

const jsonOptions = (method, value) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});

async function post(app, text, clientMessageId, roomId = "army") {
  return request(app, "/api/messages", jsonOptions("POST", { text, clientMessageId, roomId }));
}

async function waitForState(app, predicate, message) {
  return withTimeout((async () => {
    for (;;) {
      const state = await request(app, "/api/state");
      if (predicate(state)) return state;
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    }
  })(), 8_000, message);
}

async function waitForExecution(app, executionId, status) {
  const state = await waitForState(app, (candidate) => candidate.executions.find((execution) => execution.id === executionId)?.status === status, `Execution ${executionId} did not reach ${status}`);
  return state.executions.find((execution) => execution.id === executionId);
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-hub-supervision-"));
  await writeFile(join(directory, "agents.json"), JSON.stringify([{
    id: "mini-fake",
    name: "Mini Fake",
    nodeId: "mac-mini",
    transport: "local-fake",
    workspace: join(directory, "mini-workspace"),
    state: join(directory, "mini-state"),
    centralWorkspace: join(directory, "mini-central"),
    color: "yellow",
  }]));
  const app = await startApp(directory);
  t.after(async () => {
    await stopProcess(app.child);
    await rm(directory, { recursive: true, force: true });
  });
  return { app, directory };
}

test("agent connectivity exposes available, disabled, misconfigured, and unavailable states", { timeout: 30_000 }, async (t) => {
  const { app, directory } = await setup(t);
  const initial = await request(app, "/api/state");
  assert.equal(initial.agents[0].health.status, "unknown");
  const available = await request(app, "/api/agents/mini-fake/test", { method: "POST" });
  assert.equal(available.status, "available");
  assert.ok(available.checkedAt);

  await request(app, "/api/agents/mini-fake", jsonOptions("PATCH", { enabled: false }));
  const disabled = await request(app, "/api/agents/mini-fake/test", { method: "POST" });
  assert.equal(disabled.status, "disabled");
  await request(app, "/api/agents/mini-fake", jsonOptions("PATCH", { enabled: true }));
  assert.equal((await request(app, "/api/state")).agents[0].health.status, "unknown");

  const misconfigured = await request(app, "/api/agents", jsonOptions("POST", {
    name: "Missing Config",
    nodeId: "demo-dell",
    transport: "remote-acp",
    config: join(directory, "missing.json"),
    color: "pink",
  }));
  const invalid = await request(app, `/api/agents/${misconfigured.id}/test`, { method: "POST" });
  assert.equal(invalid.status, "misconfigured");
  assert.ok(invalid.error);

  const tokenPath = join(directory, "token");
  await writeFile(tokenPath, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  const configPath = join(directory, "unavailable.json");
  await writeFile(configPath, JSON.stringify({ agentId: "unavailable", host: "127.0.0.1", port: 1, tokenFile: tokenPath }));
  const unavailable = await request(app, "/api/agents", jsonOptions("POST", {
    name: "Unavailable Agent",
    nodeId: "demo-dell",
    transport: "remote-acp",
    config: configPath,
    color: "lavender",
  }));
  const offline = await request(app, `/api/agents/${unavailable.id}/test`, { method: "POST" });
  assert.equal(offline.status, "unavailable");
  assert.match(offline.error, /ECONNREFUSED|exited/i);
});

test("queue ordering, concurrent deduplication, stop, safe retry, and active-room deletion safeguards", { timeout: 30_000 }, async (t) => {
  const { app, directory } = await setup(t);
  const duplicates = await Promise.all(Array.from({ length: 5 }, () => post(app, "@Mini Fake concurrent", "concurrent-key")));
  assert.equal(duplicates.filter((result) => !result.duplicate).length, 1);
  const original = duplicates.find((result) => !result.duplicate);
  await waitForExecution(app, original.executions[0].id, "completed");
  const deduplicated = await request(app, "/api/state");
  assert.equal(deduplicated.messages.filter((message) => message.id === original.message.id).length, 1);
  assert.equal(deduplicated.executions.filter((execution) => execution.originId === original.message.id).length, 1);

  const first = await post(app, "@Mini Fake slow:800 first", "queue-first");
  const second = await post(app, "@Mini Fake second", "queue-second");
  const third = await post(app, "@Mini Fake third", "queue-third");
  await waitForState(app, (state) => {
    const statuses = Object.fromEntries([first, second, third].map((result) => [result.executions[0].id, state.executions.find((execution) => execution.id === result.executions[0].id)?.status]));
    return statuses[first.executions[0].id] === "running" && statuses[second.executions[0].id] === "queued" && statuses[third.executions[0].id] === "queued";
  }, "Per-agent queue states were not preserved");
  const stoppedQueued = await request(app, `/api/executions/${third.executions[0].id}/stop`, { method: "POST" });
  assert.equal(stoppedQueued.status, "interrupted");
  assert.deepEqual(stoppedQueued.history.map((entry) => entry.to), ["queued", "interrupted"]);
  await waitForExecution(app, first.executions[0].id, "completed");
  await waitForExecution(app, second.executions[0].id, "completed");
  const ordered = await request(app, "/api/state");
  const firstReply = ordered.messages.findIndex((message) => message.originId === first.message.id && message.authorType === "agent");
  const secondReply = ordered.messages.findIndex((message) => message.originId === second.message.id && message.authorType === "agent");
  assert.ok(firstReply >= 0 && secondReply > firstReply, "Replies preserve per-agent execution order");
  assert.equal(ordered.messages.some((message) => message.originId === third.message.id && message.authorId === "mini-fake"), false);
  await requestError(app, `/api/executions/${third.executions[0].id}/stop`, { method: "POST" }, 409);
  await requestError(app, `/api/executions/${third.executions[0].id}/retry`, { method: "POST" }, 409);

  const eventsPath = join(directory, "mini-workspace/events.jsonl");
  assert.equal((await readFile(eventsPath, "utf8")).trim().split("\n").length, 3);
  const failure = await post(app, "@Mini Fake fail-once safe retry", "safe-failure");
  const failed = await waitForExecution(app, failure.executions[0].id, "failed");
  assert.equal(failed.retrySafe, true);
  assert.match(failed.error, /pre-execution/);
  assert.ok(failed.resultMessageId);
  assert.equal((await readFile(eventsPath, "utf8")).trim().split("\n").length, 3, "Safe failure never reached execution");
  const retry = await request(app, `/api/executions/${failed.id}/retry`, { method: "POST" });
  assert.equal(retry.attempt, 2);
  assert.equal(retry.retryOf, failed.id);
  await requestError(app, `/api/executions/${failed.id}/retry`, { method: "POST" }, 409);
  const retried = await waitForExecution(app, retry.id, "completed");
  assert.ok(retried.resultMessageId);
  assert.equal((await readFile(eventsPath, "utf8")).trim().split("\n").length, 4);

  const active = await post(app, "@Mini Fake slow:5000 stop active", "stop-active");
  await waitForExecution(app, active.executions[0].id, "running");
  const stoppedActive = await request(app, `/api/executions/${active.executions[0].id}/stop`, { method: "POST" });
  assert.equal(stoppedActive.status, "interrupted");
  assert.deepEqual(stoppedActive.history.map((entry) => entry.to), ["queued", "running", "interrupted"]);
  await requestError(app, `/api/executions/${active.executions[0].id}/retry`, { method: "POST" }, 409);
  const afterStop = await post(app, "@Mini Fake after stop", "after-stop");
  await waitForExecution(app, afterStop.executions[0].id, "completed");
  const stoppedState = await request(app, "/api/state");
  assert.equal(stoppedState.messages.some((message) => message.originId === active.message.id && message.authorId === "mini-fake"), false);

  const room = await request(app, "/api/rooms", jsonOptions("POST", { name: "Active deletion guard", agentIds: ["mini-fake"] }));
  const roomWork = await post(app, "@Mini Fake slow:5000 room work", "room-active", room.id);
  await waitForExecution(app, roomWork.executions[0].id, "running");
  await requestError(app, `/api/rooms/${room.id}?confirm=delete-history`, { method: "DELETE" }, 409);
  await request(app, `/api/executions/${roomWork.executions[0].id}/stop`, { method: "POST" });
  const deletion = await request(app, `/api/rooms/${room.id}?confirm=delete-history`, { method: "DELETE" });
  assert.equal(deletion.deletedExecutions, 1);
});

test("OpenCode registration requires only non-secret CLI and unique explicit workspace configuration", { timeout: 30_000 }, async (t) => {
  const { app, directory } = await setup(t);
  await requestError(app, "/api/agents", jsonOptions("POST", {
    name: "OpenCode Invalid",
    nodeId: "mac-mini",
    transport: "local-opencode",
    centralWorkspace: join(directory, "opencode-workspace"),
  }), 400);
  await requestError(app, "/api/agents", jsonOptions("POST", {
    name: "OpenCode Missing Workspace",
    nodeId: "mac-mini",
    transport: "local-opencode",
    command: join(directory, "opencode-cli"),
  }), 400);
  const agent = await request(app, "/api/agents", jsonOptions("POST", {
    name: "OpenCode Config",
    nodeId: "mac-mini",
    transport: "local-opencode",
    command: join(directory, "opencode-cli"),
    centralWorkspace: join(directory, "opencode-workspace"),
    color: "yellow",
  }));
  assert.equal(agent.transport, "local-opencode");
  assert.equal(agent.command, join(directory, "opencode-cli"));
  assert.equal(agent.centralWorkspace, join(directory, "opencode-workspace"));
  assert.equal(Object.keys(agent).some((key) => /token|secret|password|credential|api.?key/i.test(key)), false);
  await requestError(app, "/api/agents", jsonOptions("POST", {
    name: "OpenCode Duplicate Workspace",
    nodeId: "mac-mini",
    transport: "local-opencode",
    command: join(directory, "opencode-cli"),
    centralWorkspace: join(directory, "opencode-workspace"),
  }), 409);
  const renamed = await request(app, `/api/agents/${agent.id}`, jsonOptions("PATCH", { name: "OpenCode Renamed" }));
  assert.equal(renamed.command, agent.command);
  assert.equal(renamed.centralWorkspace, agent.centralWorkspace);
});

test("bad OpenCode executables cannot crash the Hub and provider stderr is redacted", { timeout: 30_000 }, async (t) => {
  const { app, directory } = await setup(t);
  const missing = await request(app, "/api/agents", jsonOptions("POST", {
    name: "Missing OpenCode",
    nodeId: "mac-mini",
    transport: "local-opencode",
    command: join(directory, "does-not-exist"),
    centralWorkspace: join(directory, "missing-workspace"),
  }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const health = await request(app, `/api/agents/${missing.id}/test`, { method: "POST" });
    assert.equal(health.status, "misconfigured");
    assert.match(health.error, /ENOENT/);
    assert.equal((await request(app, "/api/health")).ok, true);
  }

  const fakeSecret = "unit-test-secret-123456789";
  const harness = join(directory, "secret-stderr-harness.sh");
  await writeFile(harness, `#!/bin/sh\nprintf '%s\\n' 'provider token=${fakeSecret}' >&2\nexit 1\n`, { mode: 0o700 });
  const secretAgent = await request(app, "/api/agents", jsonOptions("POST", {
    name: "Secret Failure",
    nodeId: "mac-mini",
    transport: "local-opencode",
    command: harness,
    centralWorkspace: join(directory, "secret-workspace"),
  }));
  const failedHealth = await request(app, `/api/agents/${secretAgent.id}/test`, { method: "POST" });
  assert.match(failedHealth.error, /\[REDACTED\]/);
  assert.equal(failedHealth.error.includes(fakeSecret), false);
  const posted = await post(app, "@Secret Failure fail safely", "secret-failure");
  const failed = await waitForExecution(app, posted.executions[0].id, "failed");
  assert.match(failed.error, /\[REDACTED\]/);
  const persisted = await readFile(join(directory, "hub-state.json"), "utf8");
  assert.equal(persisted.includes(fakeSecret), false);
  const state = await request(app, "/api/state");
  assert.equal(state.messages.some((message) => message.authorType === "error" && message.text.includes("[REDACTED]")), true);
  assert.equal(state.messages.some((message) => message.text.includes(fakeSecret)), false);
});
