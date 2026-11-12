import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hub } from "../server/hub.mjs";
import { MAX_ATTACHMENT_BYTES } from "../server/attachments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeScript = resolve(root, "connectors/remote-acp/node-server.mjs");
const serverScript = resolve(root, "server/server.mjs");
const harnessScript = resolve(root, "connectors/remote-acp/fake-harness.mjs");
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
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
  const ready = await waitForEvent(child, "openbot-hub.ready", () => stderr);
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

function uploadOptions(content, { name = "source.txt", mediaType = "text/plain", receipt = randomUUID() } = {}) {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Attachment-Name": encodeURIComponent(name),
      "X-Attachment-Media-Type": mediaType,
      "X-Client-Attachment-Id": receipt,
    },
    body: content,
  };
}

const upload = (app, content, options, roomId = "army") => request(app, `/api/rooms/${roomId}/attachments`, uploadOptions(content, options));
const uploadError = (app, content, options, status, roomId = "army") => requestError(app, `/api/rooms/${roomId}/attachments`, uploadOptions(content, options), status);
const post = (app, value) => request(app, "/api/messages", jsonOptions("POST", { roomId: "army", ...value }));

async function waitForExecution(app, executionId) {
  return withTimeout((async () => {
    for (;;) {
      const state = await request(app, "/api/state");
      const execution = state.executions.find((candidate) => candidate.id === executionId);
      if (execution.status === "completed") return { execution, state };
      if (["failed", "interrupted", "unknown"].includes(execution.status)) throw new Error(execution.error);
      await delay(40);
    }
  })(), 8_000, `Execution ${executionId} timed out`);
}

async function setup(t, remote = false) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-hub-attachments-test-"));
  const context = { directory, app: null, node: null };
  let node;
  if (remote) {
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
    node = spawn(process.execPath, [nodeScript, "--config", join(directory, "node.json")], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    context.node = node;
    let nodeStderr = "";
    node.stderr.on("data", (chunk) => { nodeStderr += chunk.toString("utf8"); });
    const listening = await waitForEvent(node, "openbot-hub.listening", () => nodeStderr);
    await writeFile(join(directory, "agent.json"), JSON.stringify({ agentId: "dell-fake", host: "127.0.0.1", port: listening.port, tokenFile: join(directory, "token") }));
  }
  const agents = [{
    id: "mini-fake",
    name: "Mini Fake",
    nodeId: "mac-mini",
    transport: "local-fake",
    workspace: join(directory, "mini-workspace"),
    state: join(directory, "mini-state"),
    centralWorkspace: join(directory, "mini-central"),
    color: "yellow",
  }];
  if (remote) agents.push({
    id: "dell-fake",
    name: "Dell Fake",
    nodeId: "demo-dell",
    transport: "remote-acp",
    config: join(directory, "agent.json"),
    centralWorkspace: join(directory, "dell-central"),
    color: "pink",
  });
  await writeFile(join(directory, "agents.json"), JSON.stringify(agents));
  context.app = await startApp(directory);
  t.after(async () => {
    await stopProcess(context.app?.child);
    await stopProcess(node);
    await rm(directory, { recursive: true, force: true });
  });
  return context;
}

test("attachment API enforces integrity, receipts, limits, safe names, and one-room one-message use", { timeout: 30_000 }, async (t) => {
  const context = await setup(t);
  const { app, directory } = context;
  const content = Buffer.from("Deliberate attachment payload\n", "utf8");
  const receipt = randomUUID();
  const uploaded = await upload(app, content, { receipt });
  assert.equal(uploaded.duplicate, false);
  assert.equal(uploaded.attachment.name, "source.txt");
  assert.equal(uploaded.attachment.size, content.length);
  assert.equal(uploaded.attachment.sha256, sha256(content));
  assert.equal(uploaded.attachment.messageId, null);
  assert.equal("path" in uploaded.attachment, false);
  const attachmentId = uploaded.attachment.id;
  assert.deepEqual(await readdir(join(directory, "attachments")), [attachmentId]);
  assert.deepEqual(await readFile(join(directory, "attachments", attachmentId)), content);

  const duplicate = await upload(app, content, { receipt });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.attachment.id, attachmentId);
  assert.deepEqual(await readdir(join(directory, "attachments")), [attachmentId]);
  await uploadError(app, "different content", { receipt }, 409);
  assert.deepEqual(await readdir(join(directory, "attachments")), [attachmentId]);

  await uploadError(app, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 65), {}, 413);
  await uploadError(app, "plain", { name: "source.exe", mediaType: "application/octet-stream" }, 400);
  for (const name of ["../escape.txt", "/tmp/escape.txt", "..\\escape.txt", ".", ""]) {
    await uploadError(app, "plain", { name }, 400);
  }
  await uploadError(app, Buffer.from([0xc3, 0x28]), {}, 400);
  await uploadError(app, "not a png", { name: "pixel.png", mediaType: "image/png" }, 400);
  await uploadError(app, "", {}, 400);

  const filesBeforeAbort = await readdir(join(directory, "attachments"));
  await new Promise((resolveAbort) => {
    const request = http.request({
      hostname: app.base.hostname,
      port: app.base.port,
      path: "/api/rooms/army/attachments",
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": 1024,
        "X-Attachment-Name": "partial.txt",
        "X-Attachment-Media-Type": "text/plain",
        "X-Client-Attachment-Id": randomUUID(),
      },
    });
    request.on("response", () => resolveAbort());
    request.on("error", () => resolveAbort());
    request.write("partial");
    setTimeout(() => { request.destroy(); resolveAbort(); }, 50);
  });
  await delay(100);
  assert.deepEqual(await readdir(join(directory, "attachments")), filesBeforeAbort);

  const otherRoom = await request(app, "/api/rooms", jsonOptions("POST", { name: "Other", purpose: "Cross-room rejection", agentIds: [] }));
  const clientMessageId = randomUUID();
  const posted = await post(app, { text: "Attachment without execution", clientMessageId, attachmentIds: [attachmentId] });
  assert.equal(posted.message.attachments[0].id, attachmentId);
  assert.equal(posted.message.attachments[0].messageId, posted.message.id);
  const duplicateMessage = await post(app, { text: "Attachment without execution", clientMessageId, attachmentIds: [attachmentId] });
  assert.equal(duplicateMessage.duplicate, true);
  assert.equal(duplicateMessage.message.id, posted.message.id);
  await requestError(app, "/api/messages", jsonOptions("POST", { text: "Reuse", clientMessageId: randomUUID(), roomId: "army", attachmentIds: [attachmentId] }), 409);
  await requestError(app, "/api/messages", jsonOptions("POST", { text: "Wrong room", clientMessageId: randomUUID(), roomId: otherRoom.id, attachmentIds: [attachmentId] }), 409);

  const response = await fetch(new URL(`/api/attachments/${attachmentId}/content`, app.base));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(downloaded, content);
  assert.equal(sha256(downloaded), uploaded.attachment.sha256);
  const state = await request(app, "/api/state");
  assert.equal(state.attachments.length, 1);
  assert.equal(JSON.stringify(state).includes(content.toString("utf8")), false);
});

test("Mini and remote Dell receive identical bytes, downloads survive restart, and room deletion cleans files", { timeout: 30_000 }, async (t) => {
  const context = await setup(t, true);
  const { directory } = context;
  const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 4, 5, 255]);
  const uploaded = await upload(context.app, content, { name: "pixel.png", mediaType: "image/png" });
  const attachmentId = uploaded.attachment.id;
  const posted = await post(context.app, { text: "@everyone inspect the attachment", clientMessageId: randomUUID(), attachmentIds: [attachmentId] });
  assert.deepEqual(posted.recipients.sort(), ["dell-fake", "mini-fake"]);
  for (const execution of posted.executions) await waitForExecution(context.app, execution.id);
  for (const workspace of ["mini-workspace", "dell-workspace/dell-fake"]) {
    const receivedDirectory = join(directory, workspace, "received-attachments");
    assert.deepEqual(await readdir(receivedDirectory), [attachmentId]);
    const received = await readFile(join(receivedDirectory, attachmentId));
    assert.deepEqual(received, content);
    assert.equal(sha256(received), uploaded.attachment.sha256);
  }
  assert.deepEqual(await readdir(join(directory, "attachments")), [attachmentId]);
  assert.equal(await readFile(join(directory, "escape.txt"), "utf8").catch((error) => error.code), "ENOENT");

  await stopProcess(context.app.child);
  context.app = await startApp(directory);
  const response = await fetch(new URL(`/api/attachments/${attachmentId}/content`, context.app.base));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);

  const room = await request(context.app, "/api/rooms", jsonOptions("POST", { name: "Disposable files", purpose: "Deletion cleanup", agentIds: [] }));
  const disposableUpload = await upload(context.app, "delete me", { receipt: randomUUID() }, room.id);
  await post(context.app, { text: "Room attachment", clientMessageId: randomUUID(), roomId: room.id, attachmentIds: [disposableUpload.attachment.id] });
  await request(context.app, `/api/rooms/${room.id}?confirm=delete-history`, { method: "DELETE" });
  assert.equal(await readFile(join(directory, "attachments", disposableUpload.attachment.id)).catch((error) => error.code), "ENOENT");
  const state = await request(context.app, "/api/state");
  assert.equal(state.attachments.some((attachment) => attachment.id === disposableUpload.attachment.id), false);
  assert.equal(Object.values(JSON.parse(await readFile(join(directory, "hub-state.json"), "utf8")).attachmentReceipts).includes(disposableUpload.attachment.id), false);
});

test("room deletion waits for delayed uploads and releases guards after aborted transfers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-hub-upload-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const hub = new Hub({ root: directory, statePath, agents: [] });
  await hub.load();
  const room = await hub.createRoom({ name: "Delayed uploads", purpose: "Upload deletion race", agentIds: [] });
  const deferred = () => {
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
  };
  const started = deferred();
  const resume = deferred();
  async function* delayedBody() {
    started.resolve();
    yield "delayed ";
    await resume.promise;
    yield "payload";
  }
  const pendingUpload = hub.uploadAttachment(room.id, {
    name: "delayed.txt",
    mediaType: "text/plain",
    clientAttachmentId: "delayed-upload",
    body: delayedBody(),
  });
  await started.promise;
  const deletionError = await hub.removeRoom(room.id, "delete-history")
    .then(() => null, (error) => error)
    .finally(() => resume.resolve());
  assert.equal(deletionError?.status, 409);
  assert.match(deletionError.message, /attachment upload is active/);
  const uploaded = await pendingUpload;
  assert.equal(uploaded.duplicate, false);
  assert.deepEqual(await readFile(join(directory, "attachments", uploaded.attachment.id), "utf8"), "delayed payload");

  const abortStarted = deferred();
  async function* abortedBody() {
    abortStarted.resolve();
    yield "partial";
    throw new Error("Simulated aborted transfer");
  }
  const abortedUpload = hub.uploadAttachment(room.id, {
    name: "aborted.txt",
    mediaType: "text/plain",
    clientAttachmentId: "aborted-upload",
    body: abortedBody(),
  });
  await abortStarted.promise;
  await assert.rejects(abortedUpload, /Simulated aborted transfer/);

  const removed = await hub.removeRoom(room.id, "delete-history");
  assert.equal(removed.deletedAttachments, 1);
  assert.equal(await readFile(join(directory, "attachments", uploaded.attachment.id), "utf8").catch((error) => error.code), "ENOENT");
  assert.deepEqual(await readdir(join(directory, "attachments")), []);
  assert.deepEqual(hub.state.attachments, []);
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(persisted.attachments, []);
  assert.deepEqual(persisted.attachmentReceipts, {});
});

test("legacy state loads with empty attachment metadata and limits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-hub-legacy-attachments-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  await writeFile(statePath, JSON.stringify({
    version: 5,
    rooms: [{ id: "army", name: "Army", purpose: "Legacy", global: true, agentIds: [] }],
    agentDefinitions: [],
    agents: [],
    messages: [],
    executions: [],
    approvals: [],
    receipts: {},
  }));
  const hub = new Hub({ root: directory, statePath, agents: [] });
  await hub.load();
  const snapshot = hub.snapshot();
  assert.deepEqual(snapshot.attachments, []);
  assert.equal(snapshot.limits.maxAttachmentBytes, MAX_ATTACHMENT_BYTES);
  assert.equal(snapshot.limits.maxAttachmentsPerMessage, 4);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).attachmentReceipts, {});
});
