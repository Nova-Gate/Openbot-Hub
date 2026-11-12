import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hub } from "../server/hub.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const fakeAgent = (directory) => [{
  id: "fake",
  name: "Fake",
  nodeId: "mac-mini",
  transport: "local-fake",
  workspace: join(directory, "workspace"),
  state: join(directory, "state"),
  centralWorkspace: join(directory, "central"),
  color: "yellow",
  enabled: true,
}];

async function makeHub(agentFactory = fakeAgent, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-hub-lifecycle-"));
  const hub = new Hub({
    root,
    statePath: join(directory, "hub-state.json"),
    agents: agentFactory(directory),
    promptIdleTimeoutMs: 400,
    promptAbsoluteTimeoutMs: 4_000,
    cancelGraceMs: 150,
    shutdownGraceMs: 800,
    approvalTimeoutMs: 5_000,
    ...options,
  });
  await hub.load();
  return { hub, directory };
}

async function waitForStatus(hub, executionId, expected, timeout = 15_000) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const execution = hub.state.executions.find((candidate) => candidate.id === executionId);
    if (statuses.includes(execution.status)) return execution;
    await delay(25);
  }
  const execution = hub.state.executions.find((candidate) => candidate.id === executionId);
  throw new Error(`Execution stayed ${execution?.status}; expected ${statuses.join("/")}`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForPidFile(path, timeout = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      if (pid > 0) return pid;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(20);
  }
  throw new Error(`The fixture never wrote ${path}.`);
}

async function harnessPid(directory, stateDirectory = "state") {
  const path = join(directory, stateDirectory, "agent.pid");
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      if (pid > 0) return pid;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(20);
  }
  throw new Error("The harness never wrote its PID file.");
}

async function waitUntilGone(pid, timeout = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (!processAlive(pid)) return;
    await delay(25);
  }
  throw new Error(`Process ${pid} survived cleanup.`);
}

test("an idle prompt becomes unknown, releases its process, and the next turn runs alone", { timeout: 30_000 }, async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const posted = await hub.post({ text: "@Fake hang", clientMessageId: "hang" });
  const executionId = posted.executions[0].id;
  const pid = await harnessPid(directory);
  const execution = await waitForStatus(hub, executionId, "unknown");
  assert.match(execution.error, /unknown/i);
  assert.equal(execution.retrySafe, false);
  const reply = hub.state.messages.find((message) => message.id === execution.resultMessageId);
  assert.match(reply.text, /outcome unknown/i);
  await waitUntilGone(pid);
  assert.ok(existsSync(join(directory, "workspace", "cancel-received.json")), "the prompt cancellation was never sent");
  const next = await hub.post({ text: "@Fake hello", clientMessageId: "after-timeout" });
  const completed = await waitForStatus(hub, next.executions[0].id, "completed");
  assert.equal(completed.status, "completed");
  assert.equal(existsSync(join(directory, "workspace", "overlap.txt")), false, "a new prompt overlapped the timed-out one");
});

test("a pre-dispatch failure is failed, not unknown", { timeout: 20_000 }, async (t) => {
  const { hub, directory } = await makeHub((directoryPath) => [{
    id: "broken",
    name: "Broken",
    nodeId: "mac-mini",
    transport: "local-opencode",
    command: join(directoryPath, "missing-opencode-binary"),
    centralWorkspace: join(directoryPath, "central"),
    color: "yellow",
    enabled: true,
  }]);
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const posted = await hub.post({ text: "@Broken hello", clientMessageId: "pre-dispatch" });
  const execution = await waitForStatus(hub, posted.executions[0].id, "failed");
  assert.doesNotMatch(execution.error, /unknown/i);
  assert.equal(execution.retrySafe, false);
});

test("a transport drop after dispatch is unknown", { timeout: 20_000 }, async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const posted = await hub.post({ text: "@Fake exit-mid-turn", clientMessageId: "transport-drop" });
  const execution = await waitForStatus(hub, posted.executions[0].id, "unknown");
  assert.match(execution.error, /outcome unknown/i);
  assert.equal(execution.retrySafe, false);
});

test("an approval pauses the prompt idle timer", { timeout: 20_000 }, async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const posted = await hub.post({ text: "@Fake approval", clientMessageId: "approval-pause" });
  const executionId = posted.executions[0].id;
  await waitForStatus(hub, executionId, "waiting");
  await delay(900);
  const execution = hub.state.executions.find((candidate) => candidate.id === executionId);
  assert.equal(execution.status, "waiting", "the idle timer fired while a decision was pending");
  const approval = hub.state.approvals.find((candidate) => candidate.executionId === executionId && candidate.status === "pending");
  await hub.respondApproval(approval.id, { optionId: "allow_once" });
  await waitForStatus(hub, executionId, "completed");
});

test("shutdown interrupts queued work and marks running work unknown", { timeout: 30_000 }, async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const first = await hub.post({ text: "@Fake slow:1500", clientMessageId: "shutdown-running" });
  const second = await hub.post({ text: "@Fake slow:1500", clientMessageId: "shutdown-queued" });
  await waitForStatus(hub, first.executions[0].id, "running");
  const pid = await harnessPid(directory);
  const messagesBefore = hub.state.messages.length;
  const started = Date.now();
  await hub.stop();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3_000, `shutdown took ${elapsed} ms`);
  const running = hub.state.executions.find((candidate) => candidate.id === first.executions[0].id);
  const queued = hub.state.executions.find((candidate) => candidate.id === second.executions[0].id);
  assert.equal(running.status, "unknown");
  assert.equal(queued.status, "interrupted");
  assert.equal(queued.startedAt, null);
  assert.equal(hub.state.messages.length, messagesBefore, "shutdown wrote a reply after stopping");
  await waitUntilGone(pid);
});

test("SIGTERM returns within the deadline with terminal states and no orphans", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-hub-sigterm-"));
  const agentsPath = join(directory, "agents.json");
  await writeFile(agentsPath, `${JSON.stringify(fakeAgent(directory), null, 2)}\n`);
  const statePath = join(directory, "hub-state.json");
  const child = spawn(process.execPath, [
    join(root, "server/server.mjs"),
    "--host", "127.0.0.1",
    "--port", "0",
    "--state", statePath,
    "--agents", agentsPath,
    "--shutdown-grace-ms", "800",
    "--shutdown-deadline-ms", "8000",
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { errors += chunk.toString("utf8"); });
  let base;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });
  const startup = Date.now();
  while (!base) {
    const line = output.split("\n").find((value) => value.includes("openbot-hub.ready"));
    if (line) {
      base = new URL(JSON.parse(line).url);
      break;
    }
    if (child.exitCode !== null) throw new Error(`Server exited before it was ready: ${output}`);
    if (Date.now() - startup > 10_000) throw new Error(`Server did not become ready: ${output}`);
    await delay(25);
  }
  const post = async (text, clientMessageId) => {
    const response = await fetch(new URL("/api/messages", base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, clientMessageId, roomId: "army" }),
    });
    assert.equal(response.status, 202);
    return response.json();
  };
  const first = await post("@Fake slow:5000", "sigterm-running");
  const second = await post("@Fake slow:5000", "sigterm-queued");
  const runningDeadline = Date.now() + 10_000;
  for (;;) {
    const snapshot = await (await fetch(new URL("/api/state", base))).json();
    const execution = snapshot.executions.find((candidate) => candidate.id === first.executions[0].id);
    if (execution.status === "running") break;
    if (Date.now() > runningDeadline) throw new Error("The first turn never started.");
    await delay(25);
  }
  const pid = await harnessPid(directory);
  const exited = once(child, "exit");
  const started = Date.now();
  child.kill("SIGTERM");
  const [exitCode] = await exited;
  const elapsed = Date.now() - started;
  assert.equal(exitCode, 0, `SIGTERM exited ${exitCode}: ${errors}`);
  assert.doesNotMatch(errors, /shutdown exceeded/i);
  assert.ok(elapsed < 8_000, `SIGTERM shutdown took ${elapsed} ms`);
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  const running = persisted.executions.find((candidate) => candidate.id === first.executions[0].id);
  const queued = persisted.executions.find((candidate) => candidate.id === second.executions[0].id);
  assert.equal(running.status, "unknown");
  assert.equal(queued.status, "interrupted");
  await waitUntilGone(pid, 5_000);
});

test("a follow-up turn cannot start while the timed-out process is still alive", { timeout: 30_000 }, async (t) => {
  const { hub, directory } = await makeHub(fakeAgent, { promptIdleTimeoutMs: 300, cancelGraceMs: 1_500 });
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const first = await hub.post({ text: "@Fake hang", clientMessageId: "overlap-first" });
  const pid = await harnessPid(directory);
  const second = await hub.post({ text: "@Fake hello", clientMessageId: "overlap-second" });
  await waitForStatus(hub, first.executions[0].id, "unknown");
  assert.equal(existsSync(join(directory, "workspace", "overlap.txt")), false, "the follow-up prompt ran while the cancelled process was alive");
  await waitForStatus(hub, second.executions[0].id, "completed");
  assert.equal(processAlive(pid), false);
});

test("the absolute prompt limit fires even without idle progress", { timeout: 30_000 }, async (t) => {
  const { hub, directory } = await makeHub(fakeAgent, { promptIdleTimeoutMs: 60_000, promptAbsoluteTimeoutMs: 300 });
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const posted = await hub.post({ text: "@Fake slow:5000", clientMessageId: "absolute-limit" });
  const execution = await waitForStatus(hub, posted.executions[0].id, "unknown");
  assert.match(execution.error, /absolute time limit/i);
  assert.equal(execution.retrySafe, false);
});

test("a session-request timeout retires the wedged client", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-hub-session-timeout-"));
  const silent = join(directory, "silent-harness.sh");
  const pidPath = join(directory, "silent.pid");
  await writeFile(silent, `#!/bin/sh\nprintf '%s\\n' "$$" > "${pidPath}"\nexec sleep 30\n`, { mode: 0o755 });
  await chmod(silent, 0o755);
  const hub = new Hub({
    root,
    statePath: join(directory, "hub-state.json"),
    agents: [{
      id: "silent",
      name: "Silent",
      nodeId: "mac-mini",
      transport: "local-opencode",
      command: silent,
      centralWorkspace: join(directory, "central"),
      color: "yellow",
      enabled: true,
    }],
    requestTimeoutMs: 5_000,
    shutdownGraceMs: 500,
  });
  await hub.load();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const posted = await hub.post({ text: "@Silent hello", clientMessageId: "session-timeout" });
  const pid = await waitForPidFile(pidPath);
  const execution = await waitForStatus(hub, posted.executions[0].id, "failed");
  assert.match(execution.error, /timed out/i);
  assert.equal(hub.runtime.clients.size, 0, "the wedged client was retained");
  await waitUntilGone(pid);
});

test("a malformed stream retires the client and records unknown", { timeout: 20_000 }, async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const posted = await hub.post({ text: "@Fake garble", clientMessageId: "malformed-stream" });
  const execution = await waitForStatus(hub, posted.executions[0].id, "unknown");
  assert.match(execution.error, /malformed JSON/i);
  assert.equal(hub.runtime.clients.size, 0);
  await waitUntilGone(await harnessPid(directory));
});

test("shutdown while waiting resolves the approval and rejects new work", { timeout: 20_000 }, async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const posted = await hub.post({ text: "@Fake approval", clientMessageId: "shutdown-waiting" });
  const executionId = posted.executions[0].id;
  await waitForStatus(hub, executionId, "waiting");
  const approval = hub.state.approvals.find((candidate) => candidate.executionId === executionId && candidate.status === "pending");
  assert.ok(approval, "no pending approval was recorded");
  const pid = await harnessPid(directory);
  await hub.stop();
  assert.equal(hub.state.executions.find((candidate) => candidate.id === executionId).status, "unknown");
  assert.equal(hub.state.approvals.find((candidate) => candidate.id === approval.id).status, "interrupted");
  await assert.rejects(hub.post({ text: "@Fake hello", clientMessageId: "after-stop" }), /shutting down/i);
  await waitUntilGone(pid);
});

test("shutdown stops several agents concurrently without orphans", { timeout: 30_000 }, async (t) => {
  const factory = (directory) => ["a", "b"].map((id) => ({
    id,
    name: id.toUpperCase(),
    nodeId: "mac-mini",
    transport: "local-fake",
    workspace: join(directory, `workspace-${id}`),
    state: join(directory, `state-${id}`),
    centralWorkspace: join(directory, `central-${id}`),
    color: "yellow",
    enabled: true,
  }));
  const { hub, directory } = await makeHub(factory, { shutdownGraceMs: 500 });
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const posted = await hub.post({ text: "@everyone slow:5000", clientMessageId: "multi-agent" });
  for (const execution of posted.executions) await waitForStatus(hub, execution.id, "running");
  const pids = [await harnessPid(directory, "state-a"), await harnessPid(directory, "state-b")];
  const started = Date.now();
  await hub.stop();
  assert.ok(Date.now() - started < 4_000, "shutdown was not concurrent");
  for (const execution of hub.state.executions) assert.equal(execution.status, "unknown");
  for (const pid of pids) await waitUntilGone(pid, 5_000);
});

test("shutdown awaits an in-flight client retirement and leaves no orphan", { timeout: 30_000 }, async (t) => {
  const { hub, directory } = await makeHub(fakeAgent, { shutdownGraceMs: 500 });
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await hub.post({ text: "@Fake stubborn", clientMessageId: "retirement-race" });
  const pid = await harnessPid(directory);
  const deadline = Date.now() + 10_000;
  while (hub.runtime.retiring.size === 0) {
    if (Date.now() > deadline) throw new Error("The client retirement never started.");
    await delay(20);
  }
  const started = Date.now();
  await hub.stop();
  const waited = Date.now() - started;
  assert.equal(processAlive(pid), false, "shutdown returned while the retiring child was still alive");
  assert.ok(waited >= 1_000, `shutdown did not wait for the retirement (${waited} ms)`);
});
