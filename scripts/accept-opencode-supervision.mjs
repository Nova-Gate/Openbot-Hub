import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { readdirSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function newestOpenCodeCli() {
  const base = resolve(homedir(), "Library/Application Support/ai.opencode.desktop/cli");
  try {
    const versions = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "opencode-cli")))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    if (versions.length) return join(base, versions.at(-1), "opencode-cli");
  } catch {}
  return resolve(base, "2.0.26/opencode-cli");
}

const command = process.env.OPENCODE_CLI ?? newestOpenCodeCli();
const commit = (() => {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return null; }
})();
const cliVersion = (() => {
  try { return execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim(); } catch { return null; }
})();
const artifacts = resolve(root, "artifacts/opencode-supervision");
await mkdir(resolve(root, ".runtime"), { recursive: true });
await mkdir(artifacts, { recursive: true });
const acceptanceRoot = await mkdtemp(resolve(root, ".runtime/opencode-supervision-"));
const control = join(acceptanceRoot, "control");
const workspace = join(acceptanceRoot, "workspace");
await mkdir(control, { recursive: true });
await mkdir(workspace, { recursive: true });
const agentsPath = join(control, "agents.json");
const statePath = join(control, "hub-state.json");
const providerPidPath = join(control, "provider.pid");
const marker = `QENBET_SUP_${randomBytes(6).toString("hex")}`;
const wrapper = join(control, "opencode-wrapper.sh");
await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$$" > "$QENBET_ACCEPTANCE_PID"\nexec ${JSON.stringify(command)} "$@"\n`, { mode: 0o700 });
await writeFile(join(workspace, "opencode.json"), `${JSON.stringify({ permission: { bash: "ask" } }, null, 2)}\n`);
const definition = {
  id: "opencode-real",
  name: "OpenCode Real",
  nodeId: "mac-mini",
  transport: "local-opencode",
  command: wrapper,
  centralWorkspace: workspace,
  color: "yellow",
  enabled: true,
};
await writeFile(agentsPath, `${JSON.stringify([definition], null, 2)}\n`);
let app;

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function startApp() {
  const child = spawn(process.execPath, [
    resolve(root, "server/server.mjs"),
    "--host", "127.0.0.1",
    "--port", "0",
    "--state", statePath,
    "--agents", agentsPath,
  ], {
    cwd: root,
    env: { ...process.env, QENBET_ACCEPTANCE_PID: providerPidPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const ready = await withTimeout((async () => {
    for (;;) {
      const line = stdout.split("\n").find((value) => value.includes("qenbet.ready"));
      if (line) return JSON.parse(line);
      if (child.exitCode !== null) throw new Error(`Acceptance app exited: ${stderr}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  })(), 10_000, `Acceptance app startup timed out: ${stderr}`);
  return { child, base: new URL(ready.url) };
}

async function stopApp() {
  if (!app || app.child.exitCode !== null || app.child.signalCode !== null) return;
  const current = app;
  try {
    const snapshot = await state();
    await Promise.all(snapshot.executions.filter((execution) => ["queued", "running", "waiting"].includes(execution.status)).map((execution) => request(`/api/executions/${execution.id}/stop`, { method: "POST" })));
  } catch {}
  const exited = once(current.child, "exit");
  current.child.kill("SIGTERM");
  try {
    await withTimeout(exited, 10_000, "Acceptance app shutdown timed out");
  } catch {
    current.child.kill("SIGKILL");
    await exited;
  } finally {
    if (app === current) app = null;
  }
}

async function request(path, options) {
  const response = await fetch(new URL(path, app.base), options);
  const value = await response.json();
  assert.ok(response.ok, `${path} returned ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

const jsonOptions = (method, value) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});

async function state() {
  return request("/api/state");
}

async function waitForExecution(executionId, expected) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  return withTimeout((async () => {
    for (;;) {
      const snapshot = await state();
      const execution = snapshot.executions.find((candidate) => candidate.id === executionId);
      if (statuses.includes(execution.status)) return { execution, snapshot };
      await new Promise((resolveWait) => setTimeout(resolveWait, 75));
    }
  })(), 240_000, `Execution ${executionId} did not reach ${statuses.join("/")}`);
}

async function waitForCompletionApproving(executionId) {
  return withTimeout((async () => {
    for (;;) {
      const snapshot = await state();
      const execution = snapshot.executions.find((candidate) => candidate.id === executionId);
      if (execution.status === "completed") return { execution, snapshot };
      if (["failed", "interrupted", "unknown"].includes(execution.status)) {
        throw new Error(`Execution ended ${execution.status} before completing: ${execution.error}`);
      }
      const pending = snapshot.approvals.find((approval) => approval.executionId === executionId && approval.status === "pending" && approval.kind === "permission");
      const option = pending?.options.find((candidate) => /allow_once/.test(candidate.kind));
      if (option) await request(`/api/approvals/${pending.id}`, jsonOptions("POST", { optionId: option.id }));
      else await new Promise((resolveWait) => setTimeout(resolveWait, 75));
    }
  })(), 240_000, `Execution ${executionId} did not complete while answering its question`);
}

async function waitForApproval(executionId) {
  return withTimeout((async () => {
    for (;;) {
      const snapshot = await state();
      const approval = snapshot.approvals.find((candidate) => candidate.executionId === executionId && candidate.status === "pending");
      if (approval) return approval;
      const execution = snapshot.executions.find((candidate) => candidate.id === executionId);
      if (["failed", "interrupted", "unknown", "completed"].includes(execution.status)) throw new Error(`Execution reached ${execution.status} before permission: ${execution.error}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 75));
    }
  })(), 150_000, "Real OpenCode permission request timed out");
}

async function post(text, clientMessageId) {
  const posted = await request("/api/messages", jsonOptions("POST", { text, clientMessageId, roomId: "army" }));
  assert.deepEqual(posted.recipients, [definition.id]);
  return posted.executions[0].id;
}

async function approve(executionId, expectedOperation) {
  const approval = await waitForApproval(executionId);
  assert.equal(approval.kind, "permission");
  const operation = JSON.stringify(approval.operation);
  for (const expected of expectedOperation) assert.ok(operation.includes(expected), `Permission details omit ${expected}: ${operation}`);
  const option = approval.options.find((candidate) => /allow_once/.test(candidate.kind));
  assert.ok(option, `No allow-once option in ${JSON.stringify(approval.options)}`);
  const decided = await request(`/api/approvals/${approval.id}`, jsonOptions("POST", { optionId: option.id }));
  assert.equal(decided.status, "approved");
  assert.equal(decided.executionId, executionId);
  return decided;
}

function formAnswer(schema, required) {
  if (schema.type === "string") {
    const choices = schema.enum ?? schema.oneOf?.map((choice) => choice.const);
    if (choices) return choices.find((choice) => /npm/i.test(choice)) ?? choices[0];
    return "npm";
  }
  if (schema.type === "number" || schema.type === "integer") return schema.default ?? schema.minimum ?? 1;
  if (schema.type === "boolean") return schema.default ?? false;
  if (schema.type === "array") {
    const choices = schema.items.enum ?? schema.items.anyOf?.map((choice) => choice.const);
    const selected = choices.find((choice) => /npm/i.test(choice)) ?? choices[0];
    return Array.from({ length: Math.max(1, schema.minItems ?? 0) }, () => selected);
  }
  throw new Error(`Unsupported live question type ${schema.type} (required: ${required})`);
}

async function answerQuestion(executionId) {
  const approval = await waitForApproval(executionId);
  assert.equal(approval.kind, "question");
  const content = {};
  for (const [key, schema] of Object.entries(approval.form.properties)) {
    const required = approval.form.required.includes(key);
    if (!required && key.endsWith("_custom")) continue;
    if (!required && schema.default === undefined && !["string", "array"].includes(schema.type)) continue;
    content[key] = formAnswer(schema, required);
  }
  const decided = await request(`/api/approvals/${approval.id}`, jsonOptions("POST", { action: "accept", content }));
  assert.equal(decided.status, "answered");
  assert.equal(decided.responseAction, "accept");
  assert.match(JSON.stringify(decided.responseContent), /npm/i);
  return decided;
}

async function waitForPid(path) {
  return withTimeout((async () => {
    for (;;) {
      try {
        const pid = Number(await readFile(path, "utf8"));
        if (pid > 0) return pid;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  })(), 30_000, `PID file ${path} was not created`);
}

async function assertProcessGone(pid, description) {
  await withTimeout((async () => {
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") return;
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  })(), 8_000, `${description} survived process-group cleanup`);
}

try {
  app = await startApp();
  const health = await request("/api/agents/opencode-real/test", { method: "POST" });
  assert.equal(health.status, "available", health.error);
  const providerPid = Number(await readFile(providerPidPath, "utf8"));
  assert.ok(providerPid > 0);

  const approvalId = await post(
    `@OpenCode Real Use the bash tool exactly once, not any other tool, to run: printf '%s\\n' '${marker}' > approved.txt\nThen reply with exactly REAL_APPROVAL_DONE and nothing else.`,
    "opencode-real-approval",
  );
  await approve(approvalId, [marker, "approved.txt"]);
  const approved = await waitForExecution(approvalId, "completed");
  assert.deepEqual(approved.execution.history.map((entry) => entry.to), ["queued", "running", "waiting", "running", "completed"]);
  assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), `${marker}\n`);
  const nativeSessionId = approved.snapshot.agents.find((agent) => agent.id === definition.id)?.sessionReady;
  assert.equal(nativeSessionId, true);
  const persistedApproval = JSON.parse(await readFile(statePath, "utf8"));
  const sessionId = persistedApproval.agents.find((agent) => agent.id === definition.id)?.sessionId;
  assert.ok(sessionId);
  assert.equal(persistedApproval.approvals.find((approval) => approval.executionId === approvalId).sessionId, sessionId);

  const questionId = await post(
    "@OpenCode Real You must call the question tool before doing anything else. Ask exactly one question: which package manager to use, offering Bun and npm, then wait for my answer. Do not answer it yourself, do not use bash, and do not use any other tool. After I answer npm, reply with exactly REAL_QUESTION_NPM and nothing else.",
    "opencode-real-question",
  );
  await answerQuestion(questionId);
  const questioned = await waitForCompletionApproving(questionId);
  assert.deepEqual(questioned.execution.history.map((entry) => entry.to), ["queued", "running", "waiting", "running", "completed"]);
  const questionReply = questioned.snapshot.messages.find((message) => message.id === questioned.execution.resultMessageId);
  assert.equal(questionReply.text.trim(), "REAL_QUESTION_NPM");

  console.error("ACCEPTANCE step: approval and question round trips completed");
  const stopId = await post(
    "@OpenCode Real This is an automated lifecycle acceptance test, so the command is authorised and expected to block. Use the bash tool exactly once, not any other tool, to run exactly this command and then wait quietly: sh -c 'echo $$ > stop-child.pid; exec sleep 60'\nDo not run any other command, do not explain, and do not decline.",
    "opencode-real-stop",
  );
  await approve(stopId, ["stop-child.pid", "sleep 60"]);
  const stoppedChildPid = await waitForPid(join(workspace, "stop-child.pid"));
  const stopped = await request(`/api/executions/${stopId}/stop`, { method: "POST" });
  assert.equal(stopped.status, "interrupted");
  await assertProcessGone(stoppedChildPid, "Stopped OpenCode tool child");
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).agents.find((agent) => agent.id === definition.id)?.sessionId, sessionId);

  const failureId = await post(
    "@OpenCode Real This is an automated lifecycle acceptance test, so the command is authorised and expected to block. Use the bash tool exactly once, not any other tool, to run exactly this command and then wait quietly: sh -c 'echo $$ > failure-child.pid; exec sleep 60'\nDo not run any other command, do not explain, and do not decline.",
    "opencode-real-crash",
  );
  await approve(failureId, ["failure-child.pid", "sleep 60"]);
  const failedChildPid = await waitForPid(join(workspace, "failure-child.pid"));
  const currentProviderPid = Number(await readFile(providerPidPath, "utf8"));
  assert.ok(currentProviderPid > 0);
  assert.notEqual(currentProviderPid, providerPid, "Stop must start a fresh ACP process before crash acceptance");
  process.kill(currentProviderPid, "SIGKILL");
  const failed = await waitForExecution(failureId, "unknown");
  assert.equal(failed.execution.retrySafe, false);
  assert.match(failed.execution.error, /unknown/i);
  await assertProcessGone(failedChildPid, "Crashed OpenCode tool child");

  console.error("ACCEPTANCE step: stop and provider-crash supervision completed");
  const recoveryId = await post(
    "@OpenCode Real Without using any tools, reply with exactly the token that you wrote into approved.txt earlier. Output the token and nothing else.",
    "opencode-real-post-crash-recovery",
  );
  const recovered = await waitForExecution(recoveryId, "completed");
  const recoveryReply = recovered.snapshot.messages.find((message) => message.id === recovered.execution.resultMessageId);
  assert.equal(recoveryReply.text.trim(), marker);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).agents.find((agent) => agent.id === definition.id)?.sessionId, sessionId);

  const report = {
    ok: true,
    requirements: ["EXEC-03", "EXEC-05"],
    adapter: "local-opencode",
    commit,
    date: new Date().toISOString(),
    node: process.version,
    opencodeCli: command,
    opencodeCliVersion: cliVersion,
    realModelCalls: 5,
    realPermissionRoundTrip: true,
    permissionOperationDetails: true,
    realQuestionRoundTrip: true,
    approvalStates: approved.execution.history.map((entry) => entry.to),
    questionStates: questioned.execution.history.map((entry) => entry.to),
    activeStop: stopped.status,
    stoppedDescendantCleanup: true,
    providerFailureState: failed.execution.status,
    crashedDescendantCleanup: true,
    postFailureExecution: recovered.execution.status,
    nativeSessionPreserved: true,
  };
  await writeFile(join(artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await stopApp();
  await rm(acceptanceRoot, { recursive: true, force: true });
}
