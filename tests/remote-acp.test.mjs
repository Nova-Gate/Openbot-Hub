import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = resolve(root, "connectors/remote-acp/node-server.mjs");
const proxyScript = resolve(root, "connectors/remote-acp/proxy.mjs");
const harnessScript = resolve(root, "connectors/remote-acp/fake-harness.mjs");

async function startNode(directory, token) {
  const configPath = join(directory, "node.json");
  await writeFile(configPath, JSON.stringify({
    nodeId: "test-dell",
    listenHost: "127.0.0.1",
    listenPort: 0,
    tokenFile: join(directory, "token"),
    workspaceRoot: join(directory, "remote-workspaces"),
    stateRoot: join(directory, "remote-state"),
    agents: [{ agentId: "dell-fake", title: "Dell Test Agent", command: harnessScript }],
  }));
  const child = spawn(process.execPath, [serverScript, "--config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const listening = await withTimeout(new Promise((resolveReady, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const event = JSON.parse(line);
        if (event.type === "qenbet.listening") resolveReady(event);
      }
    });
    child.once("exit", (code) => reject(new Error(`Node exited with ${code}: ${stderr}`)));
  }), 5_000, "Node startup timed out");
  return { child, port: listening.port, stderr: () => stderr };
}

class AcpClient {
  constructor(configPath) {
    this.child = spawn(process.execPath, [proxyScript, "--config", configPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.buffer = "";
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      for (let index = this.buffer.indexOf("\n"); index >= 0; index = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
          else pending.resolve(message.result);
        } else if (message.method) {
          this.notifications.push(message);
        }
      }
    });
    this.child.once("exit", (code) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`Proxy exited with ${code}: ${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const promise = withTimeout(new Promise((resolveRequest, reject) => {
      this.pending.set(id, { resolve: resolveRequest, reject });
    }), 5_000, `${method} timed out: ${this.stderr}`);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  answers() {
    return this.notifications
      .filter((message) => message.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((message) => message.params.update.content?.text ?? "");
  }

  async stop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.kill("SIGTERM");
    await exited;
  }
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

test("remote ACP round trip, execution proof, and resume after proxy restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qenbet-test-"));
  const token = randomBytes(32).toString("hex");
  await writeFile(join(directory, "token"), `${token}\n`, { mode: 0o600 });
  const node = await startNode(directory, token);
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.stop();
    await stopProcess(node.child);
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = join(directory, "agent.json");
  await writeFile(configPath, JSON.stringify({
    agentId: "dell-fake",
    host: "127.0.0.1",
    port: node.port,
    tokenFile: join(directory, "token"),
  }));

  const centralWorkspace = join(directory, "central-workspace");
  await mkdir(centralWorkspace);
  let client = new AcpClient(configPath);
  clients.push(client);
  const initialized = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(initialized.agentInfo.title, "Dell Test Agent");
  assert.equal(initialized.protocolVersion, 1);

  const created = await client.request("session/new", { cwd: centralWorkspace, mcpServers: [] });
  assert.ok(created.sessionId);
  assert.equal(created.models.currentModelId, "offline-demo");
  const prompted = await client.request("session/prompt", {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "hello remote agent" }],
  });
  assert.equal(prompted.stopReason, "end_turn");
  assert.equal(client.answers().length, 1);
  assert.match(client.answers()[0], /Execution node: test-dell/);
  assert.match(client.answers()[0], /Received: hello remote agent/);
  assert.match(client.answers()[0], /no model or paid API call/i);

  const remoteWorkspace = join(directory, "remote-workspaces/dell-fake");
  const proof = JSON.parse(await readFile(join(remoteWorkspace, "execution-proof.json"), "utf8"));
  assert.equal(proof.nodeId, "test-dell");
  assert.equal(proof.sessionId, created.sessionId);
  assert.equal(proof.workspace, remoteWorkspace);
  assert.equal(await readFile(join(remoteWorkspace, "last-prompt.txt"), "utf8"), "hello remote agent\n");
  assert.equal(existsSync(join(centralWorkspace, "last-prompt.txt")), false);
  assert.equal(existsSync(join(centralWorkspace, "execution-proof.json")), false);

  await client.stop();
  client = new AcpClient(configPath);
  clients.push(client);
  await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const loaded = await client.request("session/load", {
    sessionId: created.sessionId,
    cwd: centralWorkspace,
    mcpServers: [],
  });
  assert.equal(loaded.sessionId, created.sessionId);
  assert.ok(client.answers().some((answer) => answer.includes("hello remote agent")));
  await client.request("session/prompt", {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "after restart" }],
  });
  assert.ok(client.answers().some((answer) => answer.includes("Received: after restart")));
  const events = (await readFile(join(remoteWorkspace, "events.jsonl"), "utf8")).trim().split("\n");
  assert.equal(events.length, 2, "Two prompts execute exactly once across the restart");
});

test("node rejects an invalid connector credential before starting a harness", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qenbet-auth-test-"));
  await writeFile(join(directory, "token"), `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  await writeFile(join(directory, "wrong-token"), `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  const node = await startNode(directory);
  const clientConfig = join(directory, "wrong-agent.json");
  await writeFile(clientConfig, JSON.stringify({
    agentId: "dell-fake",
    host: "127.0.0.1",
    port: node.port,
    tokenFile: join(directory, "wrong-token"),
  }));
  const client = new AcpClient(clientConfig);
  t.after(async () => {
    await client.stop();
    await stopProcess(node.child);
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(client.request("initialize", { protocolVersion: 1, clientCapabilities: {} }));
  assert.match(client.stderr, /invalid credential/i);
  assert.equal(existsSync(join(directory, "remote-workspaces/dell-fake/execution-proof.json")), false);
});
