import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../server/acp-client.mjs";
import { Hub } from "../server/hub.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = resolve(root, "server/server.mjs");

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await withTimeout(exited, 5_000, "Process shutdown timed out");
}

async function startApp(directory, approvalTimeoutMs = 60_000) {
  const child = spawn(process.execPath, [
    serverScript,
    "--host", "127.0.0.1",
    "--port", "0",
    "--approval-timeout-ms", String(approvalTimeoutMs),
    "--state", join(directory, "hub-state.json"),
    "--agents", join(directory, "agents.json"),
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

async function post(app, text, clientMessageId) {
  return request(app, "/api/messages", jsonOptions("POST", { text, clientMessageId, roomId: "army" }));
}

async function waitForState(app, predicate, message) {
  return withTimeout((async () => {
    for (;;) {
      const state = await request(app, "/api/state");
      if (predicate(state)) return state;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  })(), 8_000, message);
}

async function waitForExecution(app, executionId, status) {
  const state = await waitForState(app, (candidate) => candidate.executions.find((execution) => execution.id === executionId)?.status === status, `Execution ${executionId} did not reach ${status}`);
  return state.executions.find((execution) => execution.id === executionId);
}

async function waitForApproval(app, executionId) {
  const state = await waitForState(app, (candidate) => candidate.approvals.some((approval) => approval.executionId === executionId && approval.status === "pending"), "Approval did not become pending");
  return state.approvals.find((approval) => approval.executionId === executionId);
}

async function setup(t, approvalTimeoutMs = 60_000) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-hub-approvals-"));
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
  let app = await startApp(directory, approvalTimeoutMs);
  t.after(async () => {
    await stopProcess(app?.child);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    get app() { return app; },
    set app(value) { app = value; },
    async restart() {
      await stopProcess(app.child);
      app = await startApp(directory, approvalTimeoutMs);
    },
  };
}

test("native form questions and detailed permissions resume with persisted terminal responses", { timeout: 30_000 }, async (t) => {
  const context = await setup(t);
  const { app, directory } = context;
  const question = await post(app, "@Mini Fake question before continuing", "question-allow");
  const questionExecutionId = question.executions[0].id;
  await waitForExecution(app, questionExecutionId, "waiting");
  const pendingQuestion = await waitForApproval(app, questionExecutionId);
  assert.match(pendingQuestion.title, /Choose how/);
  assert.equal(pendingQuestion.kind, "question");
  assert.equal(pendingQuestion.form.properties.pm.oneOf[1].const, "npm");
  assert.deepEqual(pendingQuestion.options, []);
  await requestError(app, `/api/approvals/${pendingQuestion.id}`, jsonOptions("POST", { action: "accept", content: { pm: "invented" } }), 400);
  const answers = { pm: "npm", pm_custom: "pnpm", count: 3, verbose: true, channels: ["chat", "email"] };
  const answered = await request(app, `/api/approvals/${pendingQuestion.id}`, jsonOptions("POST", { action: "accept", content: answers }));
  assert.equal(answered.status, "answered");
  assert.equal(answered.responseAction, "accept");
  assert.deepEqual(answered.responseContent, answers);
  const completedQuestion = await waitForExecution(app, questionExecutionId, "completed");
  assert.deepEqual(completedQuestion.history.map((entry) => entry.to), ["queued", "running", "waiting", "running", "completed"]);
  await requestError(app, `/api/approvals/${pendingQuestion.id}`, jsonOptions("POST", { action: "accept", content: answers }), 409);

  const permission = await post(app, "@Mini Fake approval before continuing", "permission-reject");
  const permissionExecutionId = permission.executions[0].id;
  const pendingPermission = await waitForApproval(app, permissionExecutionId);
  assert.equal(pendingPermission.kind, "permission");
  assert.deepEqual(pendingPermission.operation.rawInput.command, ["sh", "-c", "printf 'approved\\n' > approval-proof.txt"]);
  assert.match(pendingPermission.operation.rawInput.cwd, /mini-workspace$/);
  assert.match(pendingPermission.operation.locations[0].path, /approval-proof\.txt$/);
  assert.equal(pendingPermission.operation.content[0].oldText, "before\n");
  assert.equal(pendingPermission.operation.content[0].newText, "after\n");
  const rejected = await request(app, `/api/approvals/${pendingPermission.id}`, jsonOptions("POST", { optionId: "reject_once" }));
  assert.equal(rejected.status, "rejected");
  const completedRejection = await waitForExecution(app, permissionExecutionId, "completed");
  const state = await request(app, "/api/state");
  const questionReply = state.messages.find((message) => message.id === completedQuestion.resultMessageId);
  assert.match(questionReply.text, /"pm":"npm"/);
  assert.match(questionReply.text, /"pm_custom":"pnpm"/);
  const reply = state.messages.find((message) => message.id === completedRejection.resultMessageId);
  assert.match(reply.text, /rejected/);
  const persisted = JSON.parse(await readFile(join(directory, "hub-state.json"), "utf8"));
  assert.equal(persisted.version, 6);
  assert.deepEqual(persisted.approvals.map((approval) => approval.status), ["answered", "rejected"]);
  assert.equal(persisted.approvals.every((approval) => approval.resolvedAt), true);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "mini-state", "client-capabilities.json"), "utf8")), { elicitation: { form: {} } });
});

test("form decline and cancel return their explicit actions to the same native session", { timeout: 30_000 }, async (t) => {
  const context = await setup(t);
  for (const action of ["decline", "cancel"]) {
    const posted = await post(context.app, `@Mini Fake question ${action} this request`, `question-${action}`);
    const executionId = posted.executions[0].id;
    const pending = await waitForApproval(context.app, executionId);
    const decided = await request(context.app, `/api/approvals/${pending.id}`, jsonOptions("POST", { action }));
    assert.equal(decided.status, action === "decline" ? "declined" : "cancelled");
    assert.equal(decided.responseAction, action);
    assert.equal(decided.responseContent, null);
    const completed = await waitForExecution(context.app, executionId, "completed");
    const state = await request(context.app, "/api/state");
    const reply = state.messages.find((message) => message.id === completed.resultMessageId);
    assert.match(reply.text, new RegExp(`question was ${action}`));
  }
});

test("waiting stop, wrong-session rejection, expiry, and restart never leave pending work", { timeout: 30_000 }, async (t) => {
  const context = await setup(t, 500);
  const stoppedPost = await post(context.app, "@Mini Fake approval stop while waiting", "approval-stop");
  const stoppedId = stoppedPost.executions[0].id;
  const stoppedApproval = await waitForApproval(context.app, stoppedId);
  await requestError(context.app, "/api/agents/mini-fake", jsonOptions("PATCH", { name: "Blocked Rename" }), 409);
  await requestError(context.app, "/api/agents/mini-fake", { method: "DELETE" }, 409);
  const stopped = await request(context.app, `/api/executions/${stoppedId}/stop`, { method: "POST" });
  assert.equal(stopped.status, "interrupted");
  await requestError(context.app, `/api/approvals/${stoppedApproval.id}`, jsonOptions("POST", { optionId: "allow_once" }), 409);
  const afterStop = await post(context.app, "@Mini Fake healthy after waiting stop", "after-waiting-stop");
  await waitForExecution(context.app, afterStop.executions[0].id, "completed");

  const wrong = await post(context.app, "@Mini Fake question wrong-session", "wrong-session");
  await waitForExecution(context.app, wrong.executions[0].id, "failed");
  let state = await request(context.app, "/api/state");
  assert.equal(state.approvals.some((approval) => approval.executionId === wrong.executions[0].id), false);

  const expiring = await post(context.app, "@Mini Fake approval let it expire", "approval-expire");
  const expiringId = expiring.executions[0].id;
  await waitForApproval(context.app, expiringId);
  const expired = await waitForExecution(context.app, expiringId, "failed");
  assert.match(expired.error, /expired/);
  state = await request(context.app, "/api/state");
  assert.equal(state.approvals.find((approval) => approval.executionId === expiringId).status, "expired");
  await requestError(context.app, `/api/executions/${expiringId}/retry`, { method: "POST" }, 409);

  const restarting = await post(context.app, "@Mini Fake approval survive restart safely", "approval-restart");
  const restartingId = restarting.executions[0].id;
  await waitForApproval(context.app, restartingId);
  await context.restart();
  state = await request(context.app, "/api/state");
  const recovered = state.executions.find((execution) => execution.id === restartingId);
  assert.equal(recovered.status, "unknown");
  assert.match(recovered.error, /not rerun/);
  assert.equal(state.approvals.find((approval) => approval.executionId === restartingId).status, "interrupted");
  assert.equal(state.executions.filter((execution) => execution.originId === restarting.message.id).length, 1);
});

test("a decision recorded during initial persistence returns the same selection to ACP", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-hub-approval-race-"));
  const hub = new Hub({
    root: directory,
    statePath: join(directory, "hub-state.json"),
    agents: [{
      id: "mini-fake",
      name: "Mini Fake",
      nodeId: "mac-mini",
      transport: "local-fake",
      workspace: join(directory, "mini-workspace"),
      state: join(directory, "mini-state"),
      centralWorkspace: join(directory, "mini-central"),
      color: "yellow",
    }],
  });
  await hub.load();
  const originalSave = hub.save.bind(hub);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(async () => {
    release();
    hub.save = originalSave;
    await hub.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const at = new Date().toISOString();
  hub.state.agents[0].sessionId = "native-session";
  hub.state.executions.push({
    id: "race-execution",
    roomId: "army",
    originId: "race-origin",
    agentId: "mini-fake",
    status: "running",
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    endedAt: null,
    attempt: 1,
    retrySafe: false,
    error: null,
    resultMessageId: null,
    history: [{ from: "queued", to: "running", at }],
  });
  hub.save = () => gate;
  const acpResult = hub.requestApproval({
    agentId: "mini-fake",
    executionId: "race-execution",
    sessionId: "native-session",
    params: {
      toolCall: { toolCallId: "race-tool", title: "Run exact command", rawInput: { command: "printf race" } },
      options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
    },
  });
  const pending = hub.state.approvals[0];
  assert.equal(pending.status, "pending");
  const apiResponse = hub.respondApproval(pending.id, { optionId: "allow_once" });
  assert.equal(pending.status, "approved");
  assert.equal(hub.state.executions[0].status, "running");
  release();
  await apiResponse;
  assert.deepEqual(await acpResult, { outcome: { outcome: "selected", optionId: "allow_once" } });
});

test("ACP stop kills the process group and rejects the in-flight prompt", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-hub-process-group-"));
  const pidPath = join(directory, "descendant.pid");
  const harness = join(directory, "harness.mjs");
  await writeFile(harness, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf("\\n"); index >= 0; index = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1 } }) + "\\n");
    } else if (request.method === "session/prompt") {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
      child.unref();
    }
  }
});
setInterval(() => {}, 1000);
`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new AcpClient({ command: process.execPath, args: [harness], cwd: directory, requestTimeoutMs: 5_000 });
  await client.start();
  const prompting = client.prompt("session", "start descendant").catch((error) => error);
  let descendantPid;
  await withTimeout((async () => {
    for (;;) {
      try {
        descendantPid = Number(await readFile(pidPath, "utf8"));
        if (descendantPid > 0) break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  })(), 5_000, "Descendant did not start");
  process.kill(descendantPid, 0);
  await client.stop();
  const promptError = await prompting;
  assert.match(promptError.message, /stopped|exited/);
  await withTimeout((async () => {
    for (;;) {
      try {
        process.kill(descendantPid, 0);
      } catch (error) {
        if (error.code === "ESRCH") return;
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  })(), 5_000, "Descendant survived ACP stop");
});
