import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeScript = resolve(root, "connectors/remote-acp/node-server.mjs");
const serverScript = resolve(root, "server/server.mjs");
const harnessScript = resolve(root, "connectors/remote-acp/fake-harness.mjs");

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function waitForEvent(child, type, stderr) {
  return withTimeout(new Promise((resolveEvent, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === type) {
          child.stdout.off("data", onData);
          resolveEvent(event);
          return;
        }
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => reject(new Error(`Process exited with ${code}: ${stderr()}`)));
  }), 5_000, `${type} startup timed out: ${stderr()}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await withTimeout(exited, 5_000, "Process shutdown timed out");
}

async function startApp(directory) {
  const child = spawn(process.execPath, [
    serverScript,
    "--host", "127.0.0.1",
    "--port", "0",
    "--state", join(directory, "hub-state.json"),
    "--agents", join(directory, "agents.json"),
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const ready = await waitForEvent(child, "qenbet.ready", () => stderr);
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

async function post(app, text, clientMessageId, roomId = "army") {
  return request(app, "/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, clientMessageId, roomId }),
  });
}

async function waitForReply(app, originId, authorId) {
  return withTimeout((async () => {
    for (;;) {
      const state = await request(app, "/api/state");
      const reply = state.messages.find((message) => message.originId === originId && message.authorId === authorId);
      if (reply) return { reply, state };
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    }
  })(), 5_000, `Reply from ${authorId} timed out`);
}

const jsonOptions = (method, value) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});

test("persistent registry, dynamic rooms, routing, deduplication, and restart recovery", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qenbet-app-test-"));
  const token = randomBytes(32).toString("hex");
  await writeFile(join(directory, "token"), `${token}\n`, { mode: 0o600 });
  await writeFile(join(directory, "node.json"), JSON.stringify({
    nodeId: "demo-dell",
    listenHost: "127.0.0.1",
    listenPort: 0,
    tokenFile: join(directory, "token"),
    workspaceRoot: join(directory, "dell-workspace"),
    stateRoot: join(directory, "dell-state"),
    agents: [{ agentId: "dell-fake", title: "Dell Fake", command: harnessScript }],
  }));
  const node = spawn(process.execPath, [nodeScript, "--config", join(directory, "node.json")], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let nodeStderr = "";
  node.stderr.on("data", (chunk) => { nodeStderr += chunk.toString("utf8"); });
  const listening = await waitForEvent(node, "qenbet.listening", () => nodeStderr);
  await writeFile(join(directory, "agent.json"), JSON.stringify({
    agentId: "dell-fake",
    host: "127.0.0.1",
    port: listening.port,
    tokenFile: join(directory, "token"),
  }));
  await writeFile(join(directory, "agents.json"), JSON.stringify([
    {
      id: "mini-fake",
      name: "Mini Fake",
      nodeId: "mac-mini",
      transport: "local-fake",
      workspace: join(directory, "mini-workspace"),
      state: join(directory, "mini-state"),
      centralWorkspace: join(directory, "mini-central"),
      color: "yellow",
    },
    {
      id: "dell-fake",
      name: "Dell Fake",
      nodeId: "demo-dell",
      transport: "remote-acp",
      config: join(directory, "agent.json"),
      centralWorkspace: join(directory, "dell-central"),
      color: "pink",
    },
  ]));

  let app;
  t.after(async () => {
    await stopProcess(app?.child);
    await stopProcess(node);
    await rm(directory, { recursive: true, force: true });
  });

  app = await startApp(directory);
  const health = await request(app, "/api/health");
  assert.deepEqual(health, { ok: true, product: "Qenbet", accounts: false, externalAnalytics: false });
  const initial = await request(app, "/api/state");
  assert.equal(initial.rooms.length, 1);
  assert.equal(initial.rooms[0].id, "army");
  assert.equal(initial.rooms[0].global, true);
  assert.deepEqual(initial.agents.map((agent) => agent.id), ["mini-fake", "dell-fake"]);
  assert.equal(initial.messages.length, 1);
  assert.deepEqual(initial.executions, []);
  const page = await fetch(new URL("/", app.base));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Qenbet — Army/);

  const mini = await post(app, "@Mini Fake hello", "mini-request-1");
  assert.equal(mini.executions.length, 1);
  assert.equal(mini.executions[0].originId, mini.message.id);
  const miniResult = await waitForReply(app, mini.message.id, "mini-fake");
  assert.equal(miniResult.reply.nodeId, "mac-mini");
  assert.equal(miniResult.reply.roomId, "army");
  assert.equal(miniResult.reply.authorType, "agent");
  assert.match(miniResult.reply.text, /Received: @Mini Fake hello/);
  const miniExecution = miniResult.state.executions.find((execution) => execution.id === mini.executions[0].id);
  assert.equal(miniExecution.status, "completed");
  assert.equal(miniExecution.roomId, "army");
  assert.equal(miniExecution.agentId, "mini-fake");
  assert.equal(miniExecution.attempt, 1);
  assert.equal(miniExecution.retryOf, null);
  assert.equal(miniExecution.error, null);
  assert.equal(miniExecution.resultMessageId, miniResult.reply.id);
  assert.ok(miniExecution.startedAt);
  assert.ok(miniExecution.endedAt);
  assert.deepEqual(miniExecution.history.map((entry) => entry.to), ["queued", "running", "completed"]);
  assert.ok(miniExecution.history.every((entry) => entry.at));

  const dell = await post(app, "@Dell Fake hello", "dell-request-1");
  const dellResult = await waitForReply(app, dell.message.id, "dell-fake");
  assert.equal(dellResult.reply.nodeId, "demo-dell");
  assert.equal(dellResult.reply.authorType, "agent");
  assert.match(dellResult.reply.text, /Received: @Dell Fake hello/);

  const everyone = await post(app, "@everyone status", "everyone-request-1");
  assert.deepEqual(everyone.recipients, ["mini-fake", "dell-fake"]);
  await waitForReply(app, everyone.message.id, "mini-fake");
  const everyoneResult = await waitForReply(app, everyone.message.id, "dell-fake");
  const everyoneReplies = everyoneResult.state.messages.filter((message) => message.originId === everyone.message.id);
  assert.equal(everyoneReplies.length, 2);
  assert.ok(everyoneReplies.every((message) => message.authorType === "agent"));

  const project = await request(app, "/api/rooms", jsonOptions("POST", {
    name: "Operations",
    purpose: "Mini-only coordination",
    agentIds: ["mini-fake"],
  }));
  assert.notEqual(project.id, "army");
  assert.equal(project.global, false);
  const projectMessage = await post(app, "@everyone project status", "project-request-1", project.id);
  assert.deepEqual(projectMessage.recipients, ["mini-fake"]);
  assert.equal(projectMessage.executions.length, 1);
  const projectResult = await waitForReply(app, projectMessage.message.id, "mini-fake");
  assert.equal(projectResult.reply.roomId, project.id);
  assert.equal(projectResult.state.messages.filter((message) => message.originId === projectMessage.message.id).length, 1);
  await requestError(app, "/api/rooms", jsonOptions("POST", { name: "Operations", agentIds: [] }), 409);
  await requestError(app, "/api/rooms", jsonOptions("POST", { name: "Unknown members", agentIds: ["missing-agent"] }), 400);
  await requestError(app, "/api/messages", jsonOptions("POST", { text: "hello", roomId: "missing-room" }), 404);

  const updatedProject = await request(app, `/api/rooms/${project.id}`, jsonOptions("PATCH", {
    name: "Operations Expanded",
    purpose: "Mini and Dell coordination",
    agentIds: ["mini-fake", "dell-fake"],
  }));
  assert.equal(updatedProject.name, "Operations Expanded");
  assert.equal(updatedProject.purpose, "Mini and Dell coordination");
  assert.deepEqual(updatedProject.agentIds, ["mini-fake", "dell-fake"]);
  const expandedMessage = await post(app, "@everyone expanded status", "project-request-2", project.id);
  assert.deepEqual(expandedMessage.recipients, ["mini-fake", "dell-fake"]);
  assert.equal(expandedMessage.executions.length, 2);
  await waitForReply(app, expandedMessage.message.id, "mini-fake");
  const expandedResult = await waitForReply(app, expandedMessage.message.id, "dell-fake");
  assert.equal(expandedResult.state.messages.filter((message) => message.originId === expandedMessage.message.id).length, 2);
  await requestError(app, `/api/rooms/${project.id}`, jsonOptions("PATCH", { name: "Army" }), 409);
  await requestError(app, `/api/rooms/${project.id}`, jsonOptions("PATCH", { purpose: "x".repeat(241) }), 400);
  await requestError(app, `/api/rooms/${project.id}`, jsonOptions("PATCH", { agentIds: ["missing-agent"] }), 400);
  await requestError(app, `/api/rooms/${project.id}`, jsonOptions("PATCH", { global: true }), 409);

  const armyUpdate = await request(app, "/api/rooms/army", jsonOptions("PATCH", { purpose: "Global coordination for every machine." }));
  assert.equal(armyUpdate.purpose, "Global coordination for every machine.");
  await requestError(app, "/api/rooms/army", jsonOptions("PATCH", { name: "Renamed Army" }), 409);
  await requestError(app, "/api/rooms/army", jsonOptions("PATCH", { global: false }), 409);
  await requestError(app, "/api/rooms/army", jsonOptions("PATCH", { agentIds: ["mini-fake"] }), 409);
  await requestError(app, "/api/rooms/army?confirm=delete-history", { method: "DELETE" }, 409);

  const disposable = await request(app, "/api/rooms", jsonOptions("POST", {
    name: "Disposable",
    purpose: "Deletion coverage",
    agentIds: ["dell-fake"],
  }));
  const disposableMessage = await post(app, "@everyone delete me", "disposable-request", disposable.id);
  await waitForReply(app, disposableMessage.message.id, "dell-fake");
  await requestError(app, `/api/rooms/${disposable.id}`, { method: "DELETE" }, 409);
  const deletion = await request(app, `/api/rooms/${disposable.id}?confirm=delete-history`, { method: "DELETE" });
  assert.equal(deletion.removed, disposable.id);
  assert.equal(deletion.deletedMessages, 3);
  assert.equal(deletion.deletedExecutions, 1);
  const persistedAfterDelete = JSON.parse(await readFile(join(directory, "hub-state.json"), "utf8"));
  assert.equal(persistedAfterDelete.rooms.some((room) => room.id === disposable.id), false);
  assert.equal(persistedAfterDelete.messages.some((message) => message.roomId === disposable.id), false);
  assert.equal(persistedAfterDelete.executions.some((execution) => execution.roomId === disposable.id), false);
  assert.equal("disposable-request" in persistedAfterDelete.receipts, false);

  const helper = await request(app, "/api/agents", jsonOptions("POST", {
    name: "Helper Fake",
    nodeId: "mac-mini",
    transport: "local-fake",
    workspace: join(directory, "helper-workspace"),
    state: join(directory, "helper-state"),
    centralWorkspace: join(directory, "helper-central"),
    color: "pink",
    enabled: true,
  }));
  assert.ok(helper.id);
  assert.equal(helper.enabled, true);
  await requestError(app, "/api/agents", jsonOptions("POST", {
    name: "Helper Fake",
    nodeId: "other",
    transport: "local-fake",
    workspace: "unused",
    state: "unused",
  }), 409);
  const helperMessage = await post(app, "@Helper Fake first task", "helper-request-1");
  assert.deepEqual(helperMessage.recipients, [helper.id]);
  await waitForReply(app, helperMessage.message.id, helper.id);

  const renamed = await request(app, `/api/agents/${helper.id}`, jsonOptions("PATCH", { name: "Helper Renamed", color: "lavender" }));
  assert.equal(renamed.name, "Helper Renamed");
  assert.equal(renamed.workspace, helper.workspace);
  const disabled = await request(app, `/api/agents/${helper.id}`, jsonOptions("PATCH", { enabled: false }));
  assert.equal(disabled.enabled, false);
  const disabledMessage = await post(app, "@Helper Renamed should not run", "helper-disabled-request");
  assert.deepEqual(disabledMessage.recipients, []);
  const enabled = await request(app, `/api/agents/${helper.id}`, jsonOptions("PATCH", { enabled: true }));
  assert.equal(enabled.enabled, true);
  const helperResumed = await post(app, "@Helper Renamed second task", "helper-request-2");
  const helperResumeResult = await waitForReply(app, helperResumed.message.id, helper.id);
  assert.match(helperResumeResult.reply.text, /Helper Renamed is online/);
  assert.equal((await readFile(join(directory, "helper-workspace/events.jsonl"), "utf8")).trim().split("\n").length, 2);

  const beforeDuplicate = await request(app, "/api/state");
  const duplicate = await post(app, "@Mini Fake hello", "mini-request-1");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.id, mini.message.id);
  assert.deepEqual(duplicate.recipients, []);
  assert.deepEqual(duplicate.executions, []);
  const afterDuplicate = await request(app, "/api/state");
  assert.equal(afterDuplicate.messages.length, beforeDuplicate.messages.length);
  assert.equal(afterDuplicate.executions.length, beforeDuplicate.executions.length);
  const miniEventsPath = join(directory, "mini-workspace/events.jsonl");
  assert.equal((await readFile(miniEventsPath, "utf8")).trim().split("\n").length, 4);

  const beforeRestart = afterDuplicate.messages.length;
  const savedSessions = Object.fromEntries(afterDuplicate.agents.map((agent) => [agent.id, agent.sessionReady]));
  assert.deepEqual(savedSessions, { "mini-fake": true, "dell-fake": true, [helper.id]: true });
  await stopProcess(app.child);
  const statePath = join(directory, "hub-state.json");
  const persistedBeforeRestart = JSON.parse(await readFile(statePath, "utf8"));
  const interrupted = persistedBeforeRestart.executions.find((execution) => execution.id === mini.executions[0].id);
  interrupted.status = "running";
  interrupted.endedAt = null;
  interrupted.error = null;
  interrupted.resultMessageId = null;
  await writeFile(statePath, `${JSON.stringify(persistedBeforeRestart, null, 2)}\n`, { mode: 0o600 });
  app = await startApp(directory);
  const restored = await request(app, "/api/state");
  assert.equal(restored.messages.length, beforeRestart);
  assert.equal(restored.executions.length, afterDuplicate.executions.length);
  assert.equal(restored.rooms.length, 2);
  assert.equal(restored.rooms.find((room) => room.id === project.id).name, "Operations Expanded");
  assert.ok(restored.agents.some((agent) => agent.id === helper.id && agent.name === "Helper Renamed"));
  assert.deepEqual(Object.fromEntries(restored.agents.map((agent) => [agent.id, agent.sessionReady])), savedSessions);
  const recovered = restored.executions.find((execution) => execution.id === mini.executions[0].id);
  assert.equal(recovered.status, "unknown");
  assert.match(recovered.error, /not rerun/);
  assert.ok(recovered.endedAt);
  assert.equal(recovered.history.at(-1).to, "unknown");
  await requestError(app, `/api/executions/${recovered.id}/retry`, { method: "POST" }, 409);
  await requestError(app, `/api/executions/${recovered.id}/stop`, { method: "POST" }, 409);
  assert.equal((await readFile(miniEventsPath, "utf8")).trim().split("\n").length, 4);

  const resumed = await post(app, "@Mini Fake after restart", "mini-request-2");
  await waitForReply(app, resumed.message.id, "mini-fake");
  const finalState = await request(app, "/api/state");
  assert.equal(finalState.messages.length, beforeRestart + 2);
  assert.equal(finalState.messages.filter((message) => message.authorType === "error").length, 0);
  assert.equal((await readFile(miniEventsPath, "utf8")).trim().split("\n").length, 5);

  await request(app, `/api/agents/${helper.id}`, { method: "DELETE" });
  const afterRemove = await request(app, "/api/state");
  assert.equal(afterRemove.agents.some((agent) => agent.id === helper.id), false);
  assert.equal(afterRemove.messages.some((message) => message.authorId === helper.id), true);
});

test("loopback API rejects foreign origins, hosts, and non-JSON mutations without executing", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qenbet-origin-test-"));
  await writeFile(join(directory, "agents.json"), JSON.stringify([{
    id: "mini-fake",
    name: "Mini Fake",
    nodeId: "mac-mini",
    transport: "local-fake",
    workspace: join(directory, "mini-workspace"),
    state: join(directory, "mini-state"),
    centralWorkspace: join(directory, "mini-central"),
  }]));
  const app = await startApp(directory);
  t.after(async () => {
    await stopProcess(app.child);
    await rm(directory, { recursive: true, force: true });
  });
  const payload = JSON.stringify({ text: "@Mini Fake must not execute", clientMessageId: "foreign-request" });
  const rejected = [];
  for (const headers of [
    { Origin: "https://malicious.example", "Content-Type": "text/plain" },
    { "Content-Type": "text/plain" },
  ]) {
    const response = await fetch(new URL("/api/messages", app.base), { method: "POST", headers, body: payload });
    rejected.push(response.status);
    await response.json();
  }
  const rawPost = (headers) => new Promise((resolveStatus, reject) => {
    const raw = http.request({
      hostname: app.base.hostname,
      port: app.base.port,
      path: "/api/messages",
      method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(payload) },
    }, (response) => {
      response.resume();
      response.once("end", () => resolveStatus(response.statusCode));
    });
    raw.once("error", reject);
    raw.end(payload);
  });
  rejected.push(await rawPost({ Host: "malicious.example", "Content-Type": "application/json" }));
  rejected.push(await rawPost({ Host: "malicious.example", Origin: app.base.origin, "Content-Type": "application/json" }));
  assert.deepEqual(rejected, [403, 415, 403, 403]);
  const state = await request(app, "/api/state");
  assert.equal(state.executions.length, 0);
  assert.equal(state.messages.length, 1);
  const accepted = await fetch(new URL("/api/messages", app.base), {
    method: "POST",
    headers: { Origin: app.base.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "@Mini Fake same origin", clientMessageId: "same-origin" }),
  });
  assert.equal(accepted.status, 202);
  await accepted.json();
  await waitForReply(app, (await request(app, "/api/state")).messages.find((message) => message.text === "@Mini Fake same origin").id, "mini-fake");
});

test("malformed state aborts startup without replacing the original file", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qenbet-corrupt-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "agents.json"), "[]\n");
  const damaged = "{ definitely-not-valid-json\n";
  const statePath = join(directory, "hub-state.json");
  await writeFile(statePath, damaged);
  await assert.rejects(startApp(directory), /Process exited|startup timed out/);
  assert.equal(await readFile(statePath, "utf8"), damaged);
});
