import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hub } from "../server/hub.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const agent = (directory, id, name) => ({
  id,
  name,
  nodeId: "mac-mini",
  transport: "local-fake",
  workspace: join(directory, `ws-${id}`),
  state: join(directory, `st-${id}`),
  centralWorkspace: join(directory, `central-${id}`),
  color: "yellow",
  enabled: true,
});

const agents = (directory) => [
  agent(directory, "mini", "Mini"),
  agent(directory, "mini-fake", "Mini Fake"),
  agent(directory, "dev", "Dev"),
  agent(directory, "dell", "Dell"),
];

async function makeHub() {
  const directory = await mkdtemp(join(tmpdir(), "qenbet-correctness-"));
  const hub = new Hub({ root, statePath: join(directory, "hub-state.json"), agents: agents(directory) });
  await hub.load();
  return { hub, directory };
}

async function waitForStatus(hub, executionId, expected, timeout = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const execution = hub.state.executions.find((candidate) => candidate.id === executionId);
    if (execution.status === expected) return execution;
    await delay(20);
  }
  throw new Error(`Execution did not reach ${expected}.`);
}

test("mentions match whole names, longest first, and are consumed", async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const army = hub.state.rooms.find((room) => room.id === "army");
  assert.deepEqual(hub.recipients("@Mini Fake hello", army), ["mini-fake"]);
  assert.deepEqual(hub.recipients("@Mini hello", army), ["mini"]);
  assert.deepEqual(hub.recipients("@Dev hello", army), ["dev"]);
  assert.deepEqual(hub.recipients("@Devon hello", army), []);
  assert.deepEqual(hub.recipients("@everyoneX hello", army), []);
  assert.deepEqual(hub.recipients("@Mini @Dell hello", army), ["mini", "dell"]);
  assert.deepEqual(hub.recipients("hello @Mini", army), []);
  assert.deepEqual(hub.recipients("@everyone status", army), ["mini", "mini-fake", "dev", "dell"]);
});

test("idempotency receipts are scoped to their room", async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const project = await hub.createRoom({ name: "Project", purpose: "Scoped receipts", agentIds: ["mini"] });
  const first = await hub.post({ text: "@Mini army hello", clientMessageId: "same-key", roomId: "army" });
  const second = await hub.post({ text: "@Mini project hello", clientMessageId: "same-key", roomId: project.id });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  assert.equal(first.message.roomId, "army");
  assert.equal(second.message.roomId, project.id);
  assert.notEqual(first.message.id, second.message.id);
  const repeated = await hub.post({ text: "@Mini again", clientMessageId: "same-key", roomId: "army" });
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.message.id, first.message.id);
  await waitForStatus(hub, first.executions[0].id, "completed");
  await waitForStatus(hub, second.executions[0].id, "completed");
});

test("a version 6 receipt map migrates to room-scoped keys", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qenbet-migration-"));
  const messageId = randomUUID();
  const statePath = join(directory, "hub-state.json");
  await writeFile(statePath, `${JSON.stringify({
    version: 6,
    rooms: [{ id: "army", name: "Army", purpose: "All agents", global: true, agentIds: [] }],
    agentDefinitions: [agent(directory, "mini", "Mini")],
    agents: [{ id: "mini", sessionId: null, health: { status: "unknown", checkedAt: null, error: null } }],
    messages: [{
      id: messageId,
      roomId: "army",
      authorId: "mo",
      authorType: "user",
      authorName: "Mo",
      text: "legacy message",
      createdAt: new Date().toISOString(),
    }],
    executions: [],
    approvals: [],
    attachments: [],
    attachmentReceipts: {},
    receipts: { "legacy-key": messageId },
  }, null, 2)}\n`);
  const hub = new Hub({ root, statePath, agents: [agent(directory, "mini", "Mini")] });
  await hub.load();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(hub.state.version, 7);
  assert.equal(hub.state.receipts["army:legacy-key"], messageId);
  const duplicate = await hub.post({ text: "@Mini hi", clientMessageId: "legacy-key", roomId: "army" });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.id, messageId);
});

test("a failed save rolls the post back so a retry can run", async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const original = hub.save.bind(hub);
  hub.save = async () => {
    hub.save = original;
    throw new Error("simulated disk failure");
  };
  await assert.rejects(
    hub.post({ text: "@Mini rollback probe", clientMessageId: "rollback-key" }),
    /simulated disk failure/,
  );
  assert.equal(hub.state.messages.some((message) => message.text.includes("rollback probe")), false);
  assert.equal(hub.state.executions.length, 0);
  assert.equal(hub.state.receipts["army:rollback-key"], undefined);
  const retried = await hub.post({ text: "@Mini rollback probe", clientMessageId: "rollback-key" });
  assert.equal(retried.duplicate, false);
  const completed = await waitForStatus(hub, retried.executions[0].id, "completed");
  assert.equal(completed.status, "completed");
});
