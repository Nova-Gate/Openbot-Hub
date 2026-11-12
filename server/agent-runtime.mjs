import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { AcpClient } from "./acp-client.mjs";

export class AgentRuntime {
  constructor({ root, agents, onSession, onRequest, onNotification }) {
    this.root = root;
    this.agents = agents;
    this.onSession = onSession;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.clients = new Map();
    this.queues = new Map();
    this.cancellations = new Set();
    this.active = new Map();
  }

  definition(agentId) {
    const agent = this.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    return agent;
  }

  workspace(agent) {
    return resolve(this.root, agent.centralWorkspace ?? agent.workspace ?? "runtime/hub/central");
  }

  client(agent) {
    if (this.clients.has(agent.id)) return this.clients.get(agent.id);
    const common = { cwd: this.root };
    let client;
    if (agent.transport === "remote-acp") {
      client = new AcpClient({
        ...common,
        command: process.execPath,
        args: [resolve(this.root, "connectors/remote-acp/proxy.mjs"), "--config", resolve(this.root, agent.config)],
      });
    } else if (agent.transport === "local-opencode") {
      client = new AcpClient({
        command: agent.command,
        args: ["acp"],
        cwd: this.workspace(agent),
      });
    } else {
      client = new AcpClient({
        ...common,
        command: process.execPath,
        args: [resolve(this.root, "connectors/remote-acp/fake-harness.mjs")],
        env: {
          OPENBOT_HUB_NODE_ID: agent.nodeId,
          OPENBOT_HUB_AGENT_TITLE: agent.name,
          OPENBOT_HUB_WORKSPACE: resolve(this.root, agent.workspace),
          OPENBOT_HUB_STATE_ROOT: resolve(this.root, agent.state),
        },
      });
    }
    client.onRequest = (params, context) => this.handleRequest(agent.id, params, context);
    client.onNotification = (params) => this.handleNotification(agent.id, params);
    this.clients.set(agent.id, client);
    return client;
  }

  async handleRequest(agentId, params, { method }) {
    const active = this.active.get(agentId);
    if (!active || active.sessionId !== params.sessionId) throw new Error("Agent interaction does not match the active execution session.");
    if (!this.onRequest) throw new Error("This Hub does not accept agent interactions.");
    return this.onRequest({ agentId, executionId: active.executionId, sessionId: active.sessionId, method, params });
  }

  async handleNotification(agentId, params) {
    const active = this.active.get(agentId);
    if (!active || active.sessionId !== params.sessionId || !this.onNotification) return;
    await this.onNotification({ agentId, executionId: active.executionId, sessionId: active.sessionId, params });
  }

  run(agentId, sessionId, text, { executionId, attachments = [], onStart = async () => {} } = {}) {
    const previous = this.queues.get(agentId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.cancellations.has(executionId)) return { cancelled: true };
      await onStart();
      if (this.cancellations.has(executionId)) return { cancelled: true };
      const agent = this.definition(agentId);
      const centralWorkspace = this.workspace(agent);
      await mkdir(centralWorkspace, { recursive: true });
      const client = this.client(agent);
      const actualSession = await client.ensureSession(sessionId, centralWorkspace);
      if (actualSession !== sessionId) await this.onSession(agentId, actualSession);
      this.active.set(agentId, { executionId, sessionId: actualSession });
      try {
        return await client.prompt(actualSession, text, attachments);
      } finally {
        this.active.delete(agentId);
      }
    });
    this.queues.set(agentId, next.catch(() => {}));
    return next.finally(() => this.cancellations.delete(executionId));
  }

  cancel(executionId) {
    this.cancellations.add(executionId);
  }

  async test(agentId) {
    const agent = this.definition(agentId);
    await mkdir(this.workspace(agent), { recursive: true });
    const client = this.client(agent);
    await client.start();
  }

  async interrupt(agentId) {
    const client = this.clients.get(agentId);
    if (!client) return;
    this.clients.delete(agentId);
    await client.stop();
  }

  async stopAgent(agentId) {
    const queued = this.queues.get(agentId);
    if (queued) await queued;
    this.queues.delete(agentId);
    const client = this.clients.get(agentId);
    if (client) await client.stop();
    this.clients.delete(agentId);
  }

  async stop() {
    await Promise.all([...this.clients.keys()].map((agentId) => this.stopAgent(agentId)));
  }
}
