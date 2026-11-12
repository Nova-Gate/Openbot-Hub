import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const command = process.env.OPENCODE_CLI ?? resolve(homedir(), "Library/Application Support/ai.opencode.desktop/cli/2.0.26/opencode-cli");
const artifacts = resolve(root, "artifacts/opencode-acceptance");
await mkdir(resolve(root, ".runtime"), { recursive: true });
await mkdir(artifacts, { recursive: true });
const acceptanceRoot = await mkdtemp(resolve(root, ".runtime/opencode-acceptance-"));
const control = join(acceptanceRoot, "control");
const workspace = join(acceptanceRoot, "workspace");
await mkdir(control, { recursive: true });
await mkdir(workspace, { recursive: true });
const agentsPath = join(control, "agents.json");
const statePath = join(control, "hub-state.json");
const guardPath = join(control, "outside-guard.txt");
const marker = `OBH_${randomBytes(6).toString("hex")}`;
const definition = {
  id: "opencode-real",
  name: "OpenCode Real",
  nodeId: "mac-mini",
  transport: "local-opencode",
  command,
  centralWorkspace: workspace,
  color: "yellow",
  enabled: true,
};
await writeFile(agentsPath, `${JSON.stringify([definition], null, 2)}\n`);
await writeFile(guardPath, "No OpenCode task artifact may replace this file.\n");
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
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const ready = await withTimeout((async () => {
    for (;;) {
      const line = stdout.split("\n").find((value) => value.includes("openbot-hub.ready"));
      if (line) return JSON.parse(line);
      if (child.exitCode !== null) throw new Error(`Acceptance app exited: ${stderr}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  })(), 10_000, `Acceptance app startup timed out: ${stderr}`);
  return { child, base: new URL(ready.url) };
}

async function stopApp() {
  if (!app || app.child.exitCode !== null || app.child.signalCode !== null) return;
  const exited = once(app.child, "exit");
  app.child.kill("SIGTERM");
  await withTimeout(exited, 10_000, "Acceptance app shutdown timed out");
  app = null;
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

async function uploadSource() {
  return request("/api/rooms/army/attachments", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Attachment-Name": "source.txt",
      "X-Attachment-Media-Type": "text/plain",
      "X-Client-Attachment-Id": "opencode-real-source",
    },
    body: `${marker}\n`,
  });
}

async function runPrompt(text, clientMessageId, attachmentIds = []) {
  const posted = await request("/api/messages", jsonOptions("POST", { text, clientMessageId, roomId: "army", attachmentIds }));
  assert.deepEqual(posted.recipients, [definition.id]);
  const executionId = posted.executions[0].id;
  return withTimeout((async () => {
    for (;;) {
      const state = await request("/api/state");
      const execution = state.executions.find((candidate) => candidate.id === executionId);
      if (execution.status === "completed") {
        const reply = state.messages.find((message) => message.id === execution.resultMessageId);
        assert.ok(reply, "Completed execution must link to its reply");
        return { execution, reply, state };
      }
      if (["failed", "interrupted", "unknown"].includes(execution.status)) {
        throw new Error(`Real OpenCode execution reached ${execution.status}: ${execution.error}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  })(), 150_000, "Real OpenCode execution timed out");
}

async function filesBelow(directory, base = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path, base));
    else files.push(relative(base, path));
  }
  return files.sort();
}

try {
  app = await startApp();
  const health = await request("/api/agents/opencode-real/test", { method: "POST" });
  assert.equal(health.status, "available", health.error);

  const uploaded = await uploadSource();
  const attachmentId = uploaded.attachment.id;
  const firstPrompt = "@OpenCode Real Read the attached source.txt ACP embedded resource. Its text content is inlined directly after the openbot-hub URI in this same user message; that inlined text is the attachment content, not an MCP resource reference. Do not call MCP resource tools. Create evidence.txt in the current workspace containing exactly the token from that inlined attachment text followed by a newline. The token is deliberately absent from these instructions, so obtain it from the attached resource content. Do not create or modify any other file. Then reply with exactly OPENBOT_REAL_DONE and nothing else.";
  assert.equal(firstPrompt.includes(marker), false);
  const first = await runPrompt(firstPrompt, "opencode-real-file-task", [attachmentId]);
  const firstOrigin = first.state.messages.find((message) => message.id === first.execution.originId);
  assert.equal(firstOrigin.text.includes(marker), false);
  assert.equal(firstOrigin.attachments[0].id, attachmentId);
  assert.equal(firstOrigin.attachments[0].sha256, uploaded.attachment.sha256);
  assert.equal(first.reply.originId, first.execution.originId);
  assert.equal(first.execution.agentId, definition.id);
  assert.equal(first.execution.roomId, "army");
  assert.deepEqual(first.execution.history.map((entry) => entry.to), ["queued", "running", "completed"]);
  assert.equal(first.reply.authorId, definition.id);
  assert.equal(first.reply.authorType, "agent");
  assert.equal(first.reply.nodeId, definition.nodeId);
  assert.equal(first.reply.text.trim(), "OPENBOT_REAL_DONE");
  const realTools = first.execution.events.filter((event) => event.kind === "tool");
  assert.ok(realTools.length > 0, "Real OpenCode file work must emit tool progress");
  const completedTool = realTools.find((event) => event.status === "completed" && (event.operation.rawOutput !== undefined || event.operation.content !== undefined) && /evidence\.txt/.test(JSON.stringify(event.operation)));
  assert.ok(completedTool, "The real OpenCode evidence-file tool must complete with result evidence");
  assert.ok(realTools.every((event) => event.nodeId === definition.nodeId), "Real tool events must use the authoritative execution node");
  assert.equal(await readFile(join(workspace, "evidence.txt"), "utf8"), `${marker}\n`);
  assert.deepEqual(await filesBelow(workspace), ["evidence.txt"]);
  assert.deepEqual(await filesBelow(control), ["agents.json", `attachments/${attachmentId}`, "hub-state.json", "outside-guard.txt"]);
  assert.equal(await readFile(guardPath, "utf8"), "No OpenCode task artifact may replace this file.\n");
  const persistedBefore = JSON.parse(await readFile(statePath, "utf8"));
  const persistedDefinition = persistedBefore.agentDefinitions.find((agent) => agent.id === definition.id);
  assert.ok(persistedDefinition, "OpenCode definition must persist in registry state");
  assert.equal(Object.keys(persistedDefinition).some((key) => /token|secret|password|credential|api.?key/i.test(key)), false);
  assert.equal(/github_pat_|gh[pousr]_|sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+/i.test(JSON.stringify({ definitions: persistedBefore.agentDefinitions, messages: persistedBefore.messages })), false);
  const sessionBefore = persistedBefore.agents.find((agent) => agent.id === definition.id)?.sessionId;
  assert.ok(sessionBefore, "OpenCode native session ID must persist");

  await stopApp();
  app = await startApp();
  const restored = await request("/api/state");
  assert.equal(restored.agents.find((agent) => agent.id === definition.id)?.sessionReady, true);
  const second = await runPrompt(
    "@OpenCode Real Without using any tools, reply with exactly the token that you wrote into evidence.txt in the previous turn. Output the token and nothing else.",
    "opencode-real-resume-task",
  );
  assert.equal(second.reply.text.trim(), marker);
  assert.equal(second.execution.status, "completed");
  assert.deepEqual(second.execution.events, [], "Session replay and a no-tool turn must not create duplicate progress");
  const persistedAfter = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persistedAfter.agents.find((agent) => agent.id === definition.id)?.sessionId, sessionBefore);
  assert.deepEqual(await filesBelow(workspace), ["evidence.txt"]);
  assert.deepEqual(await filesBelow(control), ["agents.json", `attachments/${attachmentId}`, "hub-state.json", "hub-state.json.load-backup", "outside-guard.txt"]);
  assert.equal(await readFile(guardPath, "utf8"), "No OpenCode task artifact may replace this file.\n");

  const report = {
    ok: true,
    requirements: ["AGENT-02", "AGENT-04", "EXEC-02", "EXEC-06", "EXEC-07", "FILE-01"],
    adapter: "local-opencode",
    realModelCalls: 2,
    connectivity: health.status,
    nativeFileEvidence: true,
    attachmentResourceDelivery: { attachmentId, markerAbsentFromPrompt: true, exactTokenWritten: true, storedByUuid: true },
    realToolProgress: { count: realTools.length, completedWithResult: true, nodeId: completedTool.nodeId, replayDuplicates: 0 },
    workspaceOnlyTaskArtifacts: true,
    executionIdentity: { agentId: first.reply.authorId, nodeId: first.reply.nodeId, roomId: first.execution.roomId },
    executionStates: first.execution.history.map((entry) => entry.to),
    sessionResumeAfterHubRestart: true,
    providerCredentialFieldsInRegistry: false,
  };
  await writeFile(join(artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await stopApp();
  await rm(acceptanceRoot, { recursive: true, force: true });
}
