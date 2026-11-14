import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeExecutionEvent } from "../server/execution-events.mjs";

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
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const ready = await withTimeout((async () => {
    for (;;) {
      const line = stdout.split("\n").find((value) => value.includes("qenbet.ready"));
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

async function waitForState(app, predicate, message) {
  return withTimeout((async () => {
    for (;;) {
      const state = await request(app, "/api/state");
      if (predicate(state)) return state;
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    }
  })(), 8_000, message);
}

test("ACP progress normalization preserves tool results and plan state while ignoring transcript chunks", () => {
  assert.equal(normalizeExecutionEvent({ update: { sessionUpdate: "agent_message_chunk", content: { text: "duplicate" } } }), null);
  assert.equal(normalizeExecutionEvent({ update: { sessionUpdate: "user_message_chunk", content: { text: "duplicate" } } }), null);
  const tool = normalizeExecutionEvent({ update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    title: "Create evidence token=unit-test-secret-123456789",
    status: "completed",
    rawOutput: { stdout: "done\n", exitCode: 0 },
  } });
  assert.equal(tool.type, "tool");
  assert.equal(tool.toolCallId, "call-1");
  assert.equal(tool.status, "completed");
  assert.equal(tool.title.includes("unit-test-secret-123456789"), false);
  assert.match(tool.title, /\[REDACTED\]/);
  assert.deepEqual(tool.operation.rawOutput, { stdout: "done\n", exitCode: 0 });
  const plan = normalizeExecutionEvent({ update: {
    sessionUpdate: "plan",
    entries: [{ content: "Inspect", status: "completed", priority: "high" }, { content: "Report", status: "completed" }],
  } });
  assert.equal(plan.type, "plan");
  assert.equal(plan.status, "completed");
  assert.equal(plan.entries[0].content, "Inspect");
  assert.equal(plan.entries[0].priority, "high");
});

test("APP progress events coalesce, retain authoritative nodes, survive restart, and load legacy executions", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qenbet-progress-"));
  const agents = [
    { id: "mini-fake", name: "Mini Fake", nodeId: "mac-mini", transport: "local-fake", workspace: join(directory, "mini-workspace"), state: join(directory, "mini-state"), centralWorkspace: join(directory, "mini-central") },
    { id: "dell-fake", name: "Dell Fake", nodeId: "demo-dell", transport: "local-fake", workspace: join(directory, "dell-workspace"), state: join(directory, "dell-state"), centralWorkspace: join(directory, "dell-central") },
  ];
  await writeFile(join(directory, "agents.json"), JSON.stringify(agents));
  let app = await startApp(directory);
  t.after(async () => {
    await stopProcess(app?.child);
    await rm(directory, { recursive: true, force: true });
  });

  const posted = await request(app, "/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "@everyone progress slow:1500", clientMessageId: "progress-request", roomId: "army" }),
  });
  assert.deepEqual(posted.recipients, ["mini-fake", "dell-fake"]);
  const executionIds = posted.executions.map((execution) => execution.id);
  const pendingState = await waitForState(app, (state) => executionIds.every((id) => {
    const execution = state.executions.find((candidate) => candidate.id === id);
    return execution?.status === "running" && execution.events?.length === 2;
  }), "Pending tool and plan events did not appear");
  for (const execution of pendingState.executions.filter((candidate) => executionIds.includes(candidate.id))) {
    const expectedNode = execution.agentId === "mini-fake" ? "mac-mini" : "demo-dell";
    const tool = execution.events.find((event) => event.kind === "tool");
    const plan = execution.events.find((event) => event.kind === "plan");
    assert.equal(tool.status, "pending");
    assert.equal(tool.nodeId, expectedNode);
    assert.equal(plan.nodeId, expectedNode);
    assert.equal(plan.status, "in_progress");
    assert.deepEqual(tool.operation.rawInput.command, ["sh", "-c", "printf 'progress complete\\n'"]);
    assert.equal(tool.operation.rawOutput, undefined);
  }

  const completedState = await waitForState(app, (state) => executionIds.every((id) => state.executions.find((execution) => execution.id === id)?.status === "completed"), "Progress executions did not complete");
  for (const execution of completedState.executions.filter((candidate) => executionIds.includes(candidate.id))) {
    assert.equal(execution.events.length, 2, "Tool updates and plans must coalesce");
    const tool = execution.events.find((event) => event.kind === "tool");
    const plan = execution.events.find((event) => event.kind === "plan");
    assert.equal(tool.status, "completed");
    assert.equal(tool.operation.rawInput.cwd, join(directory, `${execution.agentId === "mini-fake" ? "mini" : "dell"}-workspace`));
    assert.equal(tool.operation.rawOutput.stdout, "progress complete\n");
    assert.equal(tool.operation.rawOutput.exitCode, 0);
    assert.equal(tool.operation.content[0].content.text, "Deterministic progress command completed.");
    assert.equal(plan.status, "completed");
    assert.ok(plan.entries.every((entry) => entry.status === "completed"));
    assert.ok(execution.resultMessageId);
  }
  const persisted = JSON.parse(await readFile(join(directory, "hub-state.json"), "utf8"));
  assert.equal(persisted.executions.find((execution) => execution.id === executionIds[0]).events.length, 2);

  await stopProcess(app.child);
  const legacyState = JSON.parse(await readFile(join(directory, "hub-state.json"), "utf8"));
  delete legacyState.executions.find((execution) => execution.id === executionIds[1]).events;
  await writeFile(join(directory, "hub-state.json"), `${JSON.stringify(legacyState, null, 2)}\n`, { mode: 0o600 });
  app = await startApp(directory);
  const restored = await request(app, "/api/state");
  const mini = restored.executions.find((execution) => execution.id === executionIds[0]);
  const legacy = restored.executions.find((execution) => execution.id === executionIds[1]);
  assert.equal(mini.status, "completed");
  assert.equal(mini.events.length, 2);
  assert.equal(mini.events.find((event) => event.kind === "tool").operation.rawOutput.exitCode, 0);
  assert.equal(legacy.status, "completed");
  assert.deepEqual(legacy.events, []);
  assert.equal(restored.executions.length, 2);
});
