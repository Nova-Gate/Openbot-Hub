import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { AcpClient } from "./acp-client.mjs";

const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

export class AgentRuntime {
  constructor({
    root,
    agents,
    onSession,
    onRequest,
    onNotification,
    requestTimeoutMs = 120_000,
    promptIdleTimeoutMs = 600_000,
    promptAbsoluteTimeoutMs = 1_800_000,
    cancelGraceMs = 2_000,
  }) {
    this.root = root;
    this.agents = agents;
    this.onSession = onSession;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.options = { requestTimeoutMs, promptIdleTimeoutMs, promptAbsoluteTimeoutMs, cancelGraceMs };
    this.clients = new Map();
    this.retiring = new Map();
    this.retirementFailures = [];
    this.queues = new Map();
    this.cancellations = new Set();
    this.active = new Map();
    this.stopping = false;
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
    const common = { cwd: this.root, ...this.options };
    let client;
    if (agent.transport === "remote-acp") {
      client = new AcpClient({
        ...common,
        command: process.execPath,
        args: [resolve(this.root, "connectors/remote-acp/proxy.mjs"), "--config", resolve(this.root, agent.config)],
      });
    } else if (agent.transport === "local-opencode") {
      client = new AcpClient({
        ...common,
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
          QENBET_NODE_ID: agent.nodeId,
          QENBET_AGENT_TITLE: agent.name,
          QENBET_WORKSPACE: resolve(this.root, agent.workspace),
          QENBET_STATE_ROOT: resolve(this.root, agent.state),
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
    if (this.stopping) return Promise.resolve({ cancelled: true });
    const previous = this.queues.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (this.stopping || this.cancellations.has(executionId)) return { cancelled: true };
      await onStart();
      if (this.stopping || this.cancellations.has(executionId)) return { cancelled: true };
      const agent = this.definition(agentId);
      const centralWorkspace = this.workspace(agent);
      await mkdir(centralWorkspace, { recursive: true });
      const client = this.client(agent);
      let actualSession;
      try {
        actualSession = await client.ensureSession(sessionId, centralWorkspace);
      } catch (error) {
        error.dispatched = false;
        error.outcomeUnknown = false;
        if (error.fatal) await this.retireClient(agentId);
        throw error;
      }
      if (actualSession !== sessionId) await this.onSession(agentId, actualSession);
      this.active.set(agentId, { executionId, sessionId: actualSession });
      try {
        return await client.prompt(actualSession, text, attachments);
      } catch (error) {
        if (error.cleanup) { try { await error.cleanup; } catch {} }
        if (error.fatal) await this.retireClient(agentId);
        throw error;
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

  pausePromptTimers(agentId) {
    this.clients.get(agentId)?.pausePromptTimers();
  }

  resumePromptTimers(agentId) {
    this.clients.get(agentId)?.resumePromptTimers();
  }

  async test(agentId) {
    const agent = this.definition(agentId);
    await mkdir(this.workspace(agent), { recursive: true });
    const client = this.client(agent);
    await client.start();
  }

  retireClient(agentId) {
    const inFlight = this.retiring.get(agentId);
    if (inFlight) return inFlight;
    const client = this.clients.get(agentId);
    if (!client) return Promise.resolve();
    this.clients.delete(agentId);
    const active = this.active.get(agentId);
    if (active) client.cancel(active.sessionId);
    let stop;
    stop = client.stop()
      .catch((error) => {
        this.retirementFailures.push({ agentId, error });
      })
      .finally(() => {
        if (this.retiring.get(agentId) === stop) this.retiring.delete(agentId);
      });
    this.retiring.set(agentId, stop);
    return stop;
  }

  async interrupt(agentId) {
    await this.retireClient(agentId);
  }

  async stopAgent(agentId) {
    this.queues.delete(agentId);
    await this.retireClient(agentId);
  }

  async shutdown({ graceMs = 5_000 } = {}) {
    this.stopping = true;
    const activeAgents = [...this.active.keys()];
    for (const [agentId, active] of this.active) this.clients.get(agentId)?.cancel(active.sessionId);
    const draining = activeAgents.length
      ? activeAgents.map((agentId) => this.queues.get(agentId)).filter(Boolean)
      : [...this.queues.values()];
    if (draining.length) {
      const drainMs = activeAgents.length ? graceMs : Math.min(graceMs, 250);
      await Promise.race([Promise.allSettled(draining.map((queue) => queue.catch(() => {}))), delay(drainMs)]);
    }
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.stop().catch((error) => {
      this.retirementFailures.push({ agentId: "shutdown", error });
    })));
    const cleanupDeadline = Date.now() + 15_000;
    while (this.retiring.size) {
      if (Date.now() > cleanupDeadline) throw new Error("Client retirement did not finish within the cleanup deadline.");
      await Promise.allSettled([...this.retiring.values()]);
    }
    this.queues.clear();
    this.active.clear();
    if (this.retirementFailures.length) {
      const first = this.retirementFailures[0];
      throw new Error(`Client cleanup failed for ${this.retirementFailures.length} agent(s): ${first.error?.message ?? first.error}`);
    }
  }

  async stop() {
    await this.shutdown({ graceMs: 2_000 });
  }
}
