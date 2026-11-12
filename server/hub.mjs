import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentRuntime } from "./agent-runtime.mjs";
import { acpAttachmentBlock, allowedAttachmentTypes, AttachmentStore, attachmentMediaType, attachmentName, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, publicAttachment } from "./attachments.mjs";
import { normalizeForm, protocolValue, validateFormContent } from "./elicitation.mjs";
import { normalizeExecutionEvent } from "./execution-events.mjs";
import { redactError } from "./redact.mjs";

const MAX_TURNS_PER_REQUEST = 6;
const COLORS = new Set(["yellow", "pink", "lavender"]);
const TRANSPORTS = new Set(["local-fake", "local-opencode", "remote-acp"]);
const EXECUTION_FIELDS = ["nodeId", "transport", "command", "workspace", "state", "config", "centralWorkspace"];
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (value, fallback = "") => typeof value === "string" ? value.trim() : fallback;

const defaultAgents = () => [
  {
    id: "mini-fake",
    name: "Mini Fake",
    nodeId: "mac-mini",
    transport: "local-fake",
    workspace: "runtime/hub/mini-workspace",
    state: "runtime/hub/mini-state",
    centralWorkspace: "runtime/hub/mini-central",
    color: "yellow",
    enabled: true,
  },
  {
    id: "dell-fake",
    name: "Dell Fake",
    nodeId: "demo-dell",
    transport: "remote-acp",
    config: "config/agent.demo.json",
    centralWorkspace: "runtime/hub/dell-central",
    color: "pink",
    enabled: true,
  },
];

const armyRoom = () => ({
  id: "army",
  name: "Army",
  purpose: "One room for every agent and every machine.",
  global: true,
  agentIds: [],
});

export class Hub {
  constructor({ root, statePath, agents = null, approvalTimeoutMs = 120_000 }) {
    this.root = root;
    this.statePath = statePath;
    this.configuredAgents = agents;
    this.approvalTimeoutMs = approvalTimeoutMs;
    this.listeners = new Set();
    this.state = null;
    this.runtime = null;
    this.saveQueue = Promise.resolve();
    this.pendingApprovals = new Map();
    this.approvalTimers = new Map();
    this.pendingAttachmentUploads = new Map();
    this.attachmentStore = new AttachmentStore(resolve(dirname(statePath), "attachments"));
  }

  async load() {
    let saved = null;
    try {
      saved = JSON.parse(await readFile(this.statePath, "utf8"));
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Hub state must be a JSON object.");
      await copyFile(this.statePath, `${this.statePath}.load-backup`);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error(`Hub state could not be loaded; the original file was left unchanged: ${redactError(error.message)}`);
      }
    }
    const seededAgents = this.configuredAgents ?? defaultAgents();
    const definitions = saved?.agentDefinitions ?? seededAgents;
    const savedRooms = Array.isArray(saved?.rooms) && saved.rooms.length ? saved.rooms : [saved?.room ?? armyRoom()];
    const rooms = savedRooms.map((room) => ({
      ...room,
      global: room.id === "army" ? true : Boolean(room.global),
      agentIds: Array.isArray(room.agentIds) ? room.agentIds : [],
    }));
    if (!rooms.some((room) => room.id === "army")) rooms.unshift(armyRoom());
    const recoveredAt = new Date().toISOString();
    const executions = (saved?.executions ?? []).map((execution) => {
      const withEvents = { ...execution, events: Array.isArray(execution.events) ? execution.events : [] };
      if (!["queued", "running", "waiting"].includes(execution.status)) return withEvents;
      const error = "The hub restarted before this execution finished; its outcome is unknown and it was not rerun.";
      return {
        ...withEvents,
        status: "unknown",
        updatedAt: recoveredAt,
        endedAt: recoveredAt,
        error,
        history: [...(execution.history ?? []), { from: execution.status, to: "unknown", at: recoveredAt, error }],
      };
    });
    const approvals = (saved?.approvals ?? []).map((approval) => {
      if (approval.status !== "pending") return approval;
      return {
        ...approval,
        status: "interrupted",
        updatedAt: recoveredAt,
        resolvedAt: recoveredAt,
        error: "The hub restarted before this decision was answered; the execution outcome is unknown.",
      };
    });
    this.state = {
      version: 6,
      rooms,
      agentDefinitions: definitions.map((agent) => ({ ...agent, enabled: agent.enabled !== false })),
      agents: definitions.map((definition) => {
        const savedAgent = saved?.agents?.find((agent) => agent.id === definition.id);
        const health = savedAgent?.health?.status === "checking" ? null : savedAgent?.health;
        return {
          id: definition.id,
          sessionId: savedAgent?.sessionId ?? null,
          health: health ?? { status: definition.enabled === false ? "disabled" : "unknown", checkedAt: null, error: null },
        };
      }),
      messages: (saved?.messages ?? [{
        id: randomUUID(),
        roomId: "army",
        authorId: "system",
        authorType: "system",
        text: "Army room ready. Mention an agent or @everyone. No accounts, external APIs, or paid model calls are used in this demo.",
        createdAt: new Date().toISOString(),
      }]).map((message) => ({ ...message, roomId: message.roomId ?? "army" })),
      executions,
      approvals,
      attachments: saved?.attachments ?? [],
      attachmentReceipts: saved?.attachmentReceipts ?? {},
      receipts: saved?.receipts ?? {},
    };
    this.runtime = new AgentRuntime({
      root: this.root,
      agents: this.state.agentDefinitions,
      onSession: async (agentId, sessionId) => {
        const agent = this.state.agents.find((candidate) => candidate.id === agentId);
        if (!agent) return;
        agent.sessionId = sessionId;
        await this.save();
        this.emit("change");
      },
      onRequest: (request) => this.requestApproval(request),
      onNotification: (notification) => this.recordExecutionEvent(notification),
    });
    await mkdir(dirname(this.statePath), { recursive: true });
    await this.attachmentStore.init();
    await this.save();
  }

  snapshot() {
    return {
      rooms: this.state.rooms,
      agents: this.state.agentDefinitions.map((definition) => {
        const session = this.state.agents.find((agent) => agent.id === definition.id);
        return {
          ...definition,
          sessionReady: Boolean(session?.sessionId),
          health: session?.health ?? { status: definition.enabled ? "unknown" : "disabled", checkedAt: null, error: null },
        };
      }),
      messages: this.state.messages,
      executions: this.state.executions,
      approvals: this.state.approvals,
      attachments: this.state.attachments.map(publicAttachment),
      attachmentTypes: allowedAttachmentTypes(),
      limits: { maxTurnsPerRequest: MAX_TURNS_PER_REQUEST, maxAttachmentBytes: MAX_ATTACHMENT_BYTES, maxAttachmentsPerMessage: MAX_ATTACHMENTS_PER_MESSAGE },
    };
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type) {
    for (const listener of this.listeners) listener(type);
  }

  save() {
    const operation = this.saveQueue.catch(() => {}).then(async () => {
      const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.statePath);
    });
    this.saveQueue = operation;
    return operation;
  }

  room(roomId) {
    const room = this.state.rooms.find((candidate) => candidate.id === roomId);
    if (!room) throw problem("Room not found.", 404);
    return room;
  }

  members(room) {
    return this.state.agentDefinitions.filter((agent) => agent.enabled && (room.global || room.agentIds.includes(agent.id)));
  }

  recipients(text, room) {
    const normalized = text.trimStart().toLowerCase();
    const members = this.members(room);
    if (normalized.startsWith("@everyone")) return members.map((agent) => agent.id);
    const selected = [];
    for (const agent of [...members].sort((a, b) => b.name.length - a.name.length)) {
      if (normalized.startsWith(`@${agent.name.toLowerCase()}`)) selected.push(agent.id);
    }
    return selected;
  }

  roomName(value, excludeId = null) {
    const name = clean(value);
    if (!name) throw problem("Room name is required.");
    if (name.length > 80) throw problem("Room name is too long.");
    if (this.state.rooms.some((room) => room.id !== excludeId && room.name.toLowerCase() === name.toLowerCase())) {
      throw problem("A room with that name already exists.", 409);
    }
    return name;
  }

  roomPurpose(value, fallback = "A focused room for coordinated work.") {
    const purpose = clean(value, fallback);
    if (purpose.length > 240) throw problem("Room purpose is too long.");
    return purpose;
  }

  roomMembers(agentIds) {
    if (!Array.isArray(agentIds)) throw problem("Room members must be an array.");
    const known = new Set(this.state.agentDefinitions.map((agent) => agent.id));
    const members = [...new Set(agentIds)];
    if (members.some((id) => typeof id !== "string" || !known.has(id))) throw problem("Room contains an unknown agent.");
    return members;
  }

  async createRoom({ name, purpose, agentIds }) {
    const room = {
      id: randomUUID(),
      name: this.roomName(name),
      purpose: this.roomPurpose(purpose),
      global: false,
      agentIds: this.roomMembers(agentIds),
    };
    this.state.rooms.push(room);
    this.state.messages.push({
      id: randomUUID(),
      roomId: room.id,
      authorId: "system",
      authorType: "system",
      text: `${room.name} is ready with ${room.agentIds.length} member${room.agentIds.length === 1 ? "" : "s"}.`,
      createdAt: new Date().toISOString(),
    });
    await this.save();
    this.emit("change");
    return room;
  }

  async updateRoom(roomId, input) {
    const room = this.room(roomId);
    if (room.global) {
      if (input.name !== undefined && clean(input.name) !== room.name) throw problem("The global room cannot be renamed.", 409);
      if (input.global !== undefined && input.global !== room.global) throw problem("The room's global status cannot be changed.", 409);
      if (input.agentIds !== undefined) throw problem("Global room membership cannot be changed.", 409);
    } else if (input.global !== undefined && input.global !== room.global) {
      throw problem("The room's global status cannot be changed.", 409);
    }
    const name = input.name === undefined ? room.name : this.roomName(input.name, room.id);
    const purpose = this.roomPurpose(input.purpose, room.purpose);
    const agentIds = input.agentIds === undefined ? room.agentIds : this.roomMembers(input.agentIds);
    Object.assign(room, { name, purpose, agentIds });
    await this.save();
    this.emit("change");
    return room;
  }

  async removeRoom(roomId, confirmation) {
    const room = this.room(roomId);
    if (room.global) throw problem("The global room cannot be deleted.", 409);
    if (confirmation !== "delete-history") throw problem("Room deletion requires delete-history confirmation.", 409);
    if (this.state.executions.some((execution) => execution.roomId === room.id && ["queued", "running", "waiting"].includes(execution.status))) {
      throw problem("Room deletion is blocked while work is active.", 409);
    }
    if (this.pendingAttachmentUploads.get(room.id)) {
      throw problem("Room deletion is blocked while an attachment upload is active.", 409);
    }
    const deletedMessages = this.state.messages.filter((message) => message.roomId === room.id);
    const deletedMessageIds = new Set(deletedMessages.map((message) => message.id));
    const deletedExecutions = this.state.executions.filter((execution) => execution.roomId === room.id).length;
    const deletedApprovals = this.state.approvals.filter((approval) => approval.roomId === room.id).length;
    const deletedAttachments = this.state.attachments.filter((attachment) => attachment.roomId === room.id);
    const deletedAttachmentIds = new Set(deletedAttachments.map((attachment) => attachment.id));
    this.state.rooms = this.state.rooms.filter((candidate) => candidate.id !== room.id);
    this.state.messages = this.state.messages.filter((message) => message.roomId !== room.id);
    this.state.executions = this.state.executions.filter((execution) => execution.roomId !== room.id);
    this.state.approvals = this.state.approvals.filter((approval) => approval.roomId !== room.id);
    this.state.attachments = this.state.attachments.filter((attachment) => attachment.roomId !== room.id);
    this.state.attachmentReceipts = Object.fromEntries(Object.entries(this.state.attachmentReceipts).filter(([, attachmentId]) => !deletedAttachmentIds.has(attachmentId)));
    this.state.receipts = Object.fromEntries(Object.entries(this.state.receipts).filter(([, messageId]) => !deletedMessageIds.has(messageId)));
    await this.save();
    await Promise.all(deletedAttachments.map((attachment) => this.attachmentStore.remove(attachment.id)));
    this.emit("change");
    return { removed: room.id, deletedMessages: deletedMessages.length, deletedExecutions, deletedApprovals, deletedAttachments: deletedAttachments.length };
  }

  normalizeAgent(input, existing = null) {
    const name = clean(input.name, existing?.name);
    const nodeId = clean(input.nodeId, existing?.nodeId);
    const transport = clean(input.transport, existing?.transport ?? "local-fake");
    if (!name || !nodeId) throw problem("Agent name and node ID are required.");
    if (name.length > 60 || nodeId.length > 60) throw problem("Agent name and node ID must be at most 60 characters.");
    if (name.includes("\n") || nodeId.includes("\n")) throw problem("Agent identity must be a single line.");
    if (!TRANSPORTS.has(transport)) throw problem("Unsupported agent transport.");
    const color = clean(input.color, existing?.color ?? "yellow");
    if (!COLORS.has(color)) throw problem("Unsupported agent color.");
    const agent = {
      id: existing?.id ?? randomUUID(),
      name,
      nodeId,
      transport,
      centralWorkspace: clean(input.centralWorkspace, existing?.centralWorkspace ?? (transport === "local-opencode" ? "" : "runtime/hub/central")),
      color,
      enabled: typeof input.enabled === "boolean" ? input.enabled : existing?.enabled ?? true,
    };
    if (transport === "remote-acp") {
      agent.config = clean(input.config, existing?.config);
      if (!agent.config) throw problem("Remote ACP agents require a connector config path.");
    } else if (transport === "local-opencode") {
      agent.command = clean(input.command, existing?.command);
      if (!agent.command || !agent.centralWorkspace) throw problem("OpenCode agents require an explicit CLI path and workspace.");
    } else {
      agent.workspace = clean(input.workspace, existing?.workspace);
      agent.state = clean(input.state, existing?.state);
      if (!agent.workspace || !agent.state) throw problem("Local fake agents require workspace and state paths.");
    }
    return agent;
  }

  assertUniqueAgentName(agent) {
    if (this.state.agentDefinitions.some((candidate) => candidate.id !== agent.id && candidate.name.toLowerCase() === agent.name.toLowerCase())) {
      throw problem("An agent with that name already exists.", 409);
    }
    if (agent.transport === "local-opencode") {
      const workspace = resolve(this.root, agent.centralWorkspace);
      const duplicate = this.state.agentDefinitions.some((candidate) => candidate.id !== agent.id && candidate.transport === "local-opencode" && resolve(this.root, candidate.centralWorkspace) === workspace);
      if (duplicate) throw problem("Another OpenCode agent already owns that workspace.", 409);
    }
  }

  async createAgent(input) {
    const agent = this.normalizeAgent(input);
    this.assertUniqueAgentName(agent);
    this.state.agentDefinitions.push(agent);
    this.state.agents.push({
      id: agent.id,
      sessionId: null,
      health: { status: agent.enabled ? "unknown" : "disabled", checkedAt: null, error: null },
    });
    await this.save();
    this.emit("change");
    return agent;
  }

  async updateAgent(agentId, input) {
    const index = this.state.agentDefinitions.findIndex((agent) => agent.id === agentId);
    if (index < 0) throw problem("Agent not found.", 404);
    if (this.state.executions.some((execution) => execution.agentId === agentId && ["queued", "running", "waiting"].includes(execution.status))) {
      throw problem("Stop active work before changing this agent.", 409);
    }
    const previous = this.state.agentDefinitions[index];
    const agent = this.normalizeAgent(input, previous);
    this.assertUniqueAgentName(agent);
    const resetSession = EXECUTION_FIELDS.some((field) => agent[field] !== previous[field]);
    const restart = resetSession || agent.name !== previous.name || agent.enabled === false;
    if (restart) await this.runtime.stopAgent(agentId);
    this.state.agentDefinitions[index] = agent;
    const session = this.state.agents.find((candidate) => candidate.id === agentId);
    if (session) {
      if (resetSession) session.sessionId = null;
      if (!agent.enabled) session.health = { status: "disabled", checkedAt: new Date().toISOString(), error: null };
      else if (!previous.enabled || resetSession) session.health = { status: "unknown", checkedAt: null, error: null };
    }
    await this.save();
    this.emit("change");
    return agent;
  }

  async removeAgent(agentId) {
    const index = this.state.agentDefinitions.findIndex((agent) => agent.id === agentId);
    if (index < 0) throw problem("Agent not found.", 404);
    if (this.state.executions.some((execution) => execution.agentId === agentId && ["queued", "running", "waiting"].includes(execution.status))) {
      throw problem("Stop active work before removing this agent.", 409);
    }
    await this.runtime.stopAgent(agentId);
    this.state.agentDefinitions.splice(index, 1);
    this.state.agents = this.state.agents.filter((agent) => agent.id !== agentId);
    for (const room of this.state.rooms) room.agentIds = room.agentIds.filter((id) => id !== agentId);
    await this.save();
    this.emit("change");
    return { removed: agentId };
  }

  async testAgent(agentId) {
    const agent = this.definitionPublic(agentId);
    const session = this.state.agents.find((candidate) => candidate.id === agentId);
    if (!agent.enabled) return { agentId, ...session.health };
    session.health = { status: "checking", checkedAt: null, error: null };
    this.emit("change");
    try {
      await this.runtime.test(agentId);
      session.health = { status: "available", checkedAt: new Date().toISOString(), error: null };
    } catch (error) {
      const message = redactError(error.message);
      const status = /config|credential|token|required|ENOENT|failed/i.test(message) ? "misconfigured" : "unavailable";
      session.health = { status, checkedAt: new Date().toISOString(), error: message };
    }
    await this.save();
    this.emit("change");
    return { agentId, ...session.health };
  }

  async uploadAttachment(roomId, { name, mediaType, clientAttachmentId, body }) {
    const room = this.room(roomId);
    const safeName = attachmentName(name);
    const safeMediaType = attachmentMediaType(safeName, mediaType);
    const receipt = clean(clientAttachmentId);
    if (!receipt || receipt.length > 128 || /[\u0000-\u001f\u007f]/.test(receipt)) throw problem("A stable client attachment ID of at most 128 characters is required.");
    const key = `${room.id}:${receipt}`;
    this.pendingAttachmentUploads.set(room.id, (this.pendingAttachmentUploads.get(room.id) ?? 0) + 1);
    try {
      const saved = await this.attachmentStore.save({ name: safeName, mediaType: safeMediaType, body });
      const existingId = this.state.attachmentReceipts[key];
      if (existingId) {
        try {
          const existing = this.state.attachments.find((attachment) => attachment.id === existingId);
          if (!existing) throw problem("The attachment receipt points to missing metadata.", 409);
          const [original, duplicate] = await Promise.all([this.attachmentStore.read(existing), this.attachmentStore.read(saved)]);
          if (existing.name !== saved.name || existing.mediaType !== saved.mediaType || !original.equals(duplicate)) {
            throw problem("This client attachment ID was already used for different content.", 409);
          }
          return { attachment: publicAttachment(existing), duplicate: true };
        } finally {
          await this.attachmentStore.remove(saved.id);
        }
      }
      const attachment = {
        id: saved.id,
        roomId: room.id,
        name: saved.name,
        mediaType: saved.mediaType,
        size: saved.size,
        sha256: saved.sha256,
        createdAt: saved.createdAt,
        messageId: null,
      };
      this.state.attachments.push(attachment);
      this.state.attachmentReceipts[key] = attachment.id;
      try {
        await this.save();
      } catch (error) {
        this.state.attachments = this.state.attachments.filter((candidate) => candidate.id !== attachment.id);
        delete this.state.attachmentReceipts[key];
        await this.attachmentStore.remove(attachment.id);
        throw error;
      }
      this.emit("change");
      return { attachment: publicAttachment(attachment), duplicate: false };
    } finally {
      const remaining = this.pendingAttachmentUploads.get(room.id) - 1;
      if (remaining > 0) this.pendingAttachmentUploads.set(room.id, remaining);
      else this.pendingAttachmentUploads.delete(room.id);
    }
  }

  async attachmentContent(attachmentId) {
    const attachment = this.state.attachments.find((candidate) => candidate.id === attachmentId);
    if (!attachment) throw problem("Attachment not found.", 404);
    return { attachment: publicAttachment(attachment), content: await this.attachmentStore.read(attachment) };
  }

  async post({ text, clientMessageId, roomId = "army", attachmentIds = [] }) {
    const messageText = clean(text);
    if (!messageText) throw problem("Message text is required.");
    if (messageText.length > 16_000) throw problem("Message is too long.", 413);
    const room = this.room(roomId);
    const receipt = clean(clientMessageId).slice(0, 128) || randomUUID();
    const existingId = this.state.receipts[receipt];
    if (existingId) {
      return { message: this.state.messages.find((message) => message.id === existingId), recipients: [], executions: [], duplicate: true };
    }
    if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE || attachmentIds.some((id) => typeof id !== "string")) {
      throw problem(`Attachments must be an array of at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachment IDs.`);
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) throw problem("An attachment can be included only once per message.", 409);
    const attachments = attachmentIds.map((id) => {
      const attachment = this.state.attachments.find((candidate) => candidate.id === id);
      if (!attachment) throw problem("Attachment not found.", 404);
      if (attachment.roomId !== room.id) throw problem("Attachments can only be used in the room where they were uploaded.", 409);
      if (attachment.messageId) throw problem("An attachment can only be sent once.", 409);
      return attachment;
    });
    const recipients = this.recipients(messageText, room);
    if (recipients.length > MAX_TURNS_PER_REQUEST) {
      throw problem(`A request can start at most ${MAX_TURNS_PER_REQUEST} agent turns.`, 409);
    }
    const message = {
      id: randomUUID(),
      roomId: room.id,
      authorId: "mo",
      authorType: "user",
      authorName: "Mo",
      text: messageText,
      createdAt: new Date().toISOString(),
      recipients,
    };
    for (const attachment of attachments) attachment.messageId = message.id;
    message.attachments = attachments.map(publicAttachment);
    const executions = recipients.map((agentId) => {
      const at = new Date().toISOString();
      return {
        id: randomUUID(),
        roomId: room.id,
        originId: message.id,
        agentId,
        status: "queued",
        createdAt: at,
        updatedAt: at,
        startedAt: null,
        endedAt: null,
        attempt: 1,
        retryOf: null,
        retrySafe: false,
        error: null,
        resultMessageId: null,
        events: [],
        history: [{ from: null, to: "queued", at }],
      };
    });
    this.state.messages.push(message);
    this.state.executions.push(...executions);
    this.state.receipts[receipt] = message.id;
    await this.save();
    this.emit("change");
    for (const execution of executions) void this.execute(execution.id);
    return { message, recipients, executions, duplicate: false };
  }

  transitionExecution(execution, status, { error = undefined, resultMessageId = undefined } = {}) {
    const allowed = {
      queued: ["running", "waiting", "failed", "interrupted", "unknown"],
      running: ["waiting", "completed", "failed", "interrupted", "unknown"],
      waiting: ["queued", "running", "failed", "interrupted", "unknown"],
      completed: [],
      failed: [],
      interrupted: [],
      unknown: [],
    };
    if (!allowed[execution.status]?.includes(status)) throw problem(`Cannot change execution from ${execution.status} to ${status}.`, 409);
    const at = new Date().toISOString();
    const previous = execution.status;
    execution.status = status;
    execution.updatedAt = at;
    if (status === "running" && !execution.startedAt) execution.startedAt = at;
    if (["completed", "failed", "interrupted", "unknown"].includes(status)) execution.endedAt = at;
    if (error !== undefined) execution.error = error;
    if (resultMessageId !== undefined) execution.resultMessageId = resultMessageId;
    execution.history.push({ from: previous, to: status, at, ...(error ? { error } : {}) });
  }

  settleApproval(approval, result = null) {
    const timer = this.approvalTimers.get(approval.id);
    if (timer) clearTimeout(timer);
    this.approvalTimers.delete(approval.id);
    const pending = this.pendingApprovals.get(approval.id);
    this.pendingApprovals.delete(approval.id);
    const cancelled = approval.kind === "question" ? { action: "cancel" } : { outcome: { outcome: "cancelled" } };
    pending?.resolve(result ?? cancelled);
  }

  interruptExecutionApprovals(executionId, error) {
    const at = new Date().toISOString();
    for (const approval of this.state.approvals.filter((candidate) => candidate.executionId === executionId && candidate.status === "pending")) {
      Object.assign(approval, { status: "interrupted", updatedAt: at, resolvedAt: at, error });
      this.settleApproval(approval);
    }
  }

  async requestApproval({ agentId, executionId, sessionId, method = "session/request_permission", params }) {
    const execution = this.execution(executionId);
    const currentSession = this.state.agents.find((candidate) => candidate.id === agentId)?.sessionId;
    if (execution.status !== "running" || currentSession !== sessionId || this.state.approvals.some((candidate) => candidate.executionId === executionId && candidate.status === "pending")) {
      throw problem("Agent interaction does not match the active execution.", 409);
    }
    const question = method === "elicitation/create";
    if (!question && method !== "session/request_permission") throw problem("Unsupported agent interaction.", 400);
    const form = question ? normalizeForm(params) : null;
    const options = question ? [] : (Array.isArray(params.options) ? params.options.slice(0, 8).map((option) => ({
      id: clean(option.optionId).slice(0, 120),
      label: redactError(clean(option.name)).slice(0, 160),
      kind: clean(option.kind, "allow_once").slice(0, 40),
    })) : []);
    if (!question && (!options.length || options.some((option) => !option.id || !option.label) || new Set(options.map((option) => option.id)).size !== options.length)) {
      throw problem("Permission request has invalid options.", 400);
    }
    const at = new Date().toISOString();
    const approval = {
      id: randomUUID(),
      kind: question ? "question" : "permission",
      executionId,
      roomId: execution.roomId,
      agentId,
      sessionId,
      title: redactError(clean(question ? params.message : params.toolCall?.title, question ? "Agent requests information" : "Agent requests a decision")).slice(0, 240),
      operation: question ? null : protocolValue(params.toolCall ?? {}),
      form,
      options,
      status: "pending",
      createdAt: at,
      updatedAt: at,
      expiresAt: new Date(Date.now() + this.approvalTimeoutMs).toISOString(),
      resolvedAt: null,
      selectedOptionId: null,
      responseAction: null,
      responseContent: null,
      error: null,
    };
    this.state.approvals.push(approval);
    this.transitionExecution(execution, "waiting");
    const pending = new Promise((resolve) => this.pendingApprovals.set(approval.id, { resolve }));
    const timer = setTimeout(() => { void this.expireApproval(approval.id); }, this.approvalTimeoutMs);
    timer.unref();
    this.approvalTimers.set(approval.id, timer);
    await this.save();
    this.emit("change");
    return pending;
  }

  async respondApproval(approvalId, input) {
    const approval = this.state.approvals.find((candidate) => candidate.id === approvalId);
    if (!approval) throw problem("Approval not found.", 404);
    if (approval.status !== "pending") throw problem("This decision is already terminal.", 409);
    const execution = this.execution(approval.executionId);
    const currentSession = this.state.agents.find((candidate) => candidate.id === approval.agentId)?.sessionId;
    if (execution.status !== "waiting" || currentSession !== approval.sessionId) throw problem("The decision no longer matches the active execution session.", 409);
    const at = new Date().toISOString();
    let result;
    if (approval.kind === "question") {
      const action = clean(input?.action);
      if (!["accept", "decline", "cancel"].includes(action)) throw problem("Choose accept, decline, or cancel.", 400);
      const content = action === "accept" ? validateFormContent(approval.form, input.content) : null;
      Object.assign(approval, {
        status: action === "accept" ? "answered" : action === "decline" ? "declined" : "cancelled",
        responseAction: action,
        responseContent: content,
        updatedAt: at,
        resolvedAt: at,
        error: null,
      });
      result = { action, ...(content ? { content } : {}) };
    } else {
      const optionId = typeof input === "string" ? input : input?.optionId;
      const option = approval.options.find((candidate) => candidate.id === clean(optionId));
      if (!option) throw problem("Choose one of the offered options.", 400);
      Object.assign(approval, {
        status: /reject|deny/i.test(option.kind) ? "rejected" : "approved",
        selectedOptionId: option.id,
        updatedAt: at,
        resolvedAt: at,
        error: null,
      });
      result = { outcome: { outcome: "selected", optionId: option.id } };
    }
    this.transitionExecution(execution, "running");
    await this.save();
    this.settleApproval(approval, result);
    this.emit("change");
    return approval;
  }

  async expireApproval(approvalId) {
    const approval = this.state.approvals.find((candidate) => candidate.id === approvalId);
    if (!approval || approval.status !== "pending") return approval;
    const execution = this.execution(approval.executionId);
    if (execution.status !== "waiting") return approval;
    const at = new Date().toISOString();
    const error = "Decision expired; the active execution was stopped without retrying it.";
    Object.assign(approval, { status: "expired", updatedAt: at, resolvedAt: at, error });
    this.settleApproval(approval);
    const agent = this.definitionPublic(execution.agentId);
    const reply = {
      id: randomUUID(),
      roomId: execution.roomId,
      authorId: execution.agentId,
      authorType: "error",
      authorName: agent.name,
      nodeId: agent.nodeId,
      originId: execution.originId,
      text: `Execution failed: ${error}`,
      createdAt: at,
    };
    this.state.messages.push(reply);
    this.transitionExecution(execution, "failed", { error, resultMessageId: reply.id });
    execution.retrySafe = false;
    await this.runtime.interrupt(execution.agentId);
    await this.save();
    this.emit("change");
    return approval;
  }

  async recordExecutionEvent({ agentId, executionId, sessionId, params }) {
    const normalized = normalizeExecutionEvent(params);
    if (!normalized) return null;
    const execution = this.execution(executionId);
    const agent = this.definitionPublic(agentId);
    const currentSession = this.state.agents.find((candidate) => candidate.id === agentId)?.sessionId;
    if (execution.agentId !== agentId || currentSession !== sessionId || !["running", "waiting"].includes(execution.status)) return null;
    execution.events ??= [];
    const at = new Date().toISOString();
    let event = normalized.type === "tool"
      ? execution.events.find((candidate) => candidate.kind === "tool" && candidate.toolCallId === normalized.toolCallId)
      : execution.events.find((candidate) => candidate.kind === "plan");
    if (event) {
      event.title = normalized.title || event.title;
      event.status = normalized.status || event.status;
      event.updatedAt = at;
      if (normalized.type === "tool") event.operation = { ...event.operation, ...normalized.operation };
      else event.entries = normalized.entries;
    } else {
      event = {
        id: randomUUID(),
        kind: normalized.type,
        nodeId: agent.nodeId,
        title: normalized.title,
        status: normalized.status,
        createdAt: at,
        updatedAt: at,
        ...(normalized.type === "tool" ? { toolCallId: normalized.toolCallId, operation: normalized.operation } : { entries: normalized.entries }),
      };
      execution.events.push(event);
      if (execution.events.length > 100) execution.events.splice(0, execution.events.length - 100);
    }
    await this.save();
    this.emit("change");
    return event;
  }

  async execute(executionId) {
    const execution = this.state.executions.find((candidate) => candidate.id === executionId);
    if (!execution) throw problem("Execution not found.", 404);
    if (execution.status !== "queued") return execution;
    const origin = this.state.messages.find((message) => message.id === execution.originId);
    const agent = this.state.agentDefinitions.find((candidate) => candidate.id === execution.agentId);
    try {
      if (!origin || !agent) throw problem("Execution origin or agent is missing.", 404);
      const attachments = [];
      for (const metadata of origin.attachments ?? []) {
        const attachment = this.state.attachments.find((candidate) => candidate.id === metadata.id && candidate.roomId === origin.roomId);
        if (!attachment) throw problem("Execution attachment metadata is missing.", 409);
        const content = await this.attachmentStore.read(attachment);
        attachments.push(acpAttachmentBlock(attachment, content));
      }
      const sessionId = this.state.agents.find((candidate) => candidate.id === execution.agentId)?.sessionId;
      const result = await this.runtime.run(execution.agentId, sessionId, origin.text, {
        executionId,
        attachments,
        onStart: async () => {
          if (execution.status !== "queued") return;
          this.transitionExecution(execution, "running");
          await this.save();
          this.emit("change");
        },
      });
      if (result.cancelled || execution.status !== "running") return execution;
      const reply = {
        id: randomUUID(),
        roomId: origin.roomId,
        authorId: execution.agentId,
        authorType: "agent",
        authorName: agent.name,
        nodeId: agent.nodeId,
        originId: origin.id,
        text: result.answer || `Agent completed with stop reason ${result.stopReason}.`,
        createdAt: new Date().toISOString(),
      };
      this.state.messages.push(reply);
      this.transitionExecution(execution, "completed", { error: null, resultMessageId: reply.id });
      await this.save();
      this.emit("change");
    } catch (error) {
      if (!["queued", "running", "waiting"].includes(execution.status)) return execution;
      const message = redactError(error.message);
      this.interruptExecutionApprovals(execution.id, `Execution failed before a decision was completed: ${message}`);
      const reply = {
        id: randomUUID(),
        roomId: execution.roomId,
        authorId: execution.agentId,
        authorType: "error",
        authorName: agent?.name ?? execution.agentId,
        nodeId: agent?.nodeId,
        originId: execution.originId,
        text: `Execution failed: ${message}`,
        createdAt: new Date().toISOString(),
      };
      this.state.messages.push(reply);
      execution.retrySafe = error.retrySafe === true;
      this.transitionExecution(execution, "failed", { error: message, resultMessageId: reply.id });
      await this.save();
      this.emit("change");
    }
    return execution;
  }

  execution(executionId) {
    const execution = this.state.executions.find((candidate) => candidate.id === executionId);
    if (!execution) throw problem("Execution not found.", 404);
    return execution;
  }

  async stopExecution(executionId) {
    const execution = this.execution(executionId);
    if (!["queued", "running", "waiting"].includes(execution.status)) throw problem("Only active work can be stopped.", 409);
    const status = execution.status;
    this.runtime.cancel(execution.id);
    this.interruptExecutionApprovals(execution.id, "Stopped by Mo before a decision was completed.");
    this.transitionExecution(execution, "interrupted", { error: "Stopped by Mo.", resultMessageId: null });
    execution.retrySafe = false;
    if (status === "running" || status === "waiting") await this.runtime.interrupt(execution.agentId);
    await this.save();
    this.emit("change");
    return execution;
  }

  async retryExecution(executionId) {
    const previous = this.execution(executionId);
    if (previous.status !== "failed" || !previous.retrySafe) throw problem("Only known-safe pre-execution failures can be retried.", 409);
    if (this.state.executions.some((execution) => execution.retryOf === previous.id)) throw problem("This failure has already been retried.", 409);
    const origin = this.state.messages.find((message) => message.id === previous.originId);
    const agent = this.definitionPublic(previous.agentId);
    this.room(previous.roomId);
    if (!origin) throw problem("Execution origin not found.", 404);
    if (!agent.enabled) throw problem("Enable the agent before retrying.", 409);
    const at = new Date().toISOString();
    const execution = {
      id: randomUUID(),
      roomId: previous.roomId,
      originId: previous.originId,
      agentId: previous.agentId,
      status: "queued",
      createdAt: at,
      updatedAt: at,
      startedAt: null,
      endedAt: null,
      attempt: previous.attempt + 1,
      retryOf: previous.id,
      retrySafe: false,
      error: null,
      resultMessageId: null,
      events: [],
      history: [{ from: null, to: "queued", at }],
    };
    this.state.executions.push(execution);
    await this.save();
    this.emit("change");
    void this.execute(execution.id);
    return execution;
  }

  definitionPublic(agentId) {
    const agent = this.state.agentDefinitions.find((candidate) => candidate.id === agentId);
    if (!agent) throw problem(`Unknown agent ${agentId}`, 404);
    return agent;
  }

  async stop() {
    const waiting = this.state.executions.filter((execution) => execution.status === "waiting");
    for (const execution of waiting) {
      const error = "The hub stopped while awaiting a decision; the outcome is unknown and it was not rerun.";
      this.runtime.cancel(execution.id);
      this.interruptExecutionApprovals(execution.id, error);
      this.transitionExecution(execution, "unknown", { error });
      await this.runtime.interrupt(execution.agentId);
    }
    if (waiting.length) await this.save();
    await this.runtime.stop();
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
    await this.saveQueue;
  }
}
