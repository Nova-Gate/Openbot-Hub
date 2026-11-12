import { spawn } from "node:child_process";
import { redactError } from "./redact.mjs";

const failure = (message, extra = {}) => Object.assign(new Error(redactError(message)), extra);

export class AcpClient {
  constructor({
    command,
    args,
    env = {},
    cwd,
    requestTimeoutMs = 120_000,
    promptIdleTimeoutMs = 600_000,
    promptAbsoluteTimeoutMs = 1_800_000,
    cancelGraceMs = 2_000,
    onRequest = null,
    onNotification = null,
  }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.requestTimeoutMs = requestTimeoutMs;
    this.promptIdleTimeoutMs = promptIdleTimeoutMs;
    this.promptAbsoluteTimeoutMs = promptAbsoluteTimeoutMs;
    this.cancelGraceMs = cancelGraceMs;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.child = null;
    this.pending = new Map();
    this.notifications = [];
    this.notificationQueue = Promise.resolve();
    this.notificationError = null;
    this.nextId = 1;
    this.buffer = "";
    this.stderr = "";
    this.startPromise = null;
  }

  #clearTimers(entry) {
    clearTimeout(entry.timer);
    clearTimeout(entry.idleTimer);
    clearTimeout(entry.absoluteTimer);
  }

  #rejectPending(reason) {
    const base = reason instanceof Error ? reason.message : String(reason);
    for (const [id, entry] of this.pending) {
      this.#clearTimers(entry);
      const extra = reason instanceof Error ? { ...reason } : {};
      delete extra.message;
      entry.reject(failure(base, {
        ...extra,
        dispatched: entry.dispatched ?? true,
        outcomeUnknown: true,
        fatal: true,
        ...(entry.prompt ? { prompt: true, sessionId: entry.sessionId } : {}),
      }));
      this.pending.delete(id);
    }
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      this.child = child;
      child.stderr.on("data", (chunk) => {
        this.stderr = redactError(`${this.stderr}${chunk.toString("utf8")}`).slice(-16_000);
      });
      child.stdout.on("data", (chunk) => this.#consume(chunk));
      child.once("error", (cause) => {
        this.#rejectPending(failure(`ACP process failed: ${redactError(cause.message)}`, { dispatched: false }));
      });
      child.stdin.once("error", (cause) => {
        this.#rejectPending(failure(`ACP input failed: ${redactError(cause.message)}`, { dispatched: true }));
      });
      child.once("exit", (code) => {
        if (child.pid && process.platform !== "win32") {
          try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
          const cleanup = setTimeout(() => {
            try { process.kill(-child.pid, "SIGKILL"); } catch {}
          }, 2_000);
          cleanup.unref();
        }
        this.#rejectPending(failure(`ACP process exited (${code}): ${this.stderr}`, { dispatched: true }));
        if (this.child === child) this.child = null;
        this.startPromise = null;
      });
      await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { elicitation: { form: {} } },
      });
    })();
    try {
      await this.startPromise;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  #respond(id, payload) {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`);
  }

  async #handleRequest(message) {
    this.#touchPrompts();
    try {
      if (!["session/request_permission", "elicitation/create"].includes(message.method) || !this.onRequest) {
        this.#respond(message.id, { error: { code: -32601, message: `Unsupported client method: ${message.method}` } });
        return;
      }
      const result = await this.onRequest(message.params, { method: message.method });
      this.#respond(message.id, { result });
    } catch (error) {
      this.#respond(message.id, { error: { code: error.status === 400 ? -32602 : -32000, message: redactError(error.message) } });
    }
  }

  #consume(chunk) {
    this.buffer += chunk.toString("utf8");
    for (let index = this.buffer.indexOf("\n"); index >= 0; index = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#rejectPending(failure("ACP stream contained malformed JSON.", { dispatched: true }));
        continue;
      }
      if (message.id !== undefined && message.method) {
        void this.#handleRequest(message);
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        this.#clearTimers(pending);
        if (message.error) {
          const error = failure(`${message.error.code}: ${message.error.message}`, {
            dispatched: pending.dispatched ?? true,
            outcomeUnknown: false,
            retrySafe: message.error.code === -32010,
            ...(pending.prompt ? { prompt: true, sessionId: pending.sessionId } : {}),
          });
          pending.reject(error);
        } else pending.resolve(message.result);
      } else if (message.method === "session/update") {
        this.#touchPrompts();
        this.#queueNotification(message.params);
      }
    }
  }

  #touchPrompts() {
    for (const entry of this.pending.values()) {
      if (!entry.prompt || entry.paused) continue;
      clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => this.#promptTimedOut(entry.id), this.promptIdleTimeoutMs);
    }
  }

  #promptTimedOut(id, absolute = false) {
    const entry = this.pending.get(id);
    if (!entry?.prompt) return;
    this.pending.delete(id);
    this.#clearTimers(entry);
    const cleanup = this.#abort(entry.sessionId);
    cleanup.catch(() => {});
    entry.reject(failure(
      absolute
        ? "The prompt exceeded its absolute time limit; it may still have run, so its outcome is unknown."
        : "The agent stopped making progress and the prompt timed out; it may still have run, so its outcome is unknown.",
      { dispatched: true, outcomeUnknown: true, prompt: true, timeout: true, fatal: true, sessionId: entry.sessionId, cleanup },
    ));
  }

  async #abort(sessionId) {
    this.cancel(sessionId);
    await new Promise((resolveWait) => setTimeout(resolveWait, this.cancelGraceMs));
    await this.stop().catch(() => {});
  }

  #queueNotification(params) {
    this.notificationQueue = this.notificationQueue.then(async () => {
      this.notifications.push(params);
      if (this.onNotification) await this.onNotification(params);
    }).catch((error) => {
      this.notificationError ??= error;
    });
  }

  async settleNotifications() {
    await this.notificationQueue;
    if (!this.notificationError) return;
    const error = this.notificationError;
    this.notificationError = null;
    throw error;
  }

  request(method, params = {}) {
    if (!this.child) throw failure("ACP client is not running.", { dispatched: false });
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const entry = { resolve, reject, dispatched: false, prompt: false };
      entry.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failure(`${method} timed out: ${this.stderr}`, { dispatched: entry.dispatched, fatal: true }));
      }, this.requestTimeoutMs);
      this.pending.set(id, entry);
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        entry.dispatched = true;
      } catch (error) {
        this.pending.delete(id);
        this.#clearTimers(entry);
        reject(failure(`${method} could not be sent: ${error.message}`, { dispatched: false, fatal: true }));
      }
    });
    return promise;
  }

  async prompt(sessionId, text, attachments = []) {
    if (!this.child) throw failure("ACP client is not running.", { dispatched: false, prompt: true });
    const baseline = this.notifications.length;
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const entry = { resolve, reject, prompt: true, sessionId, dispatched: false, paused: false, id };
      entry.idleTimer = setTimeout(() => this.#promptTimedOut(id), this.promptIdleTimeoutMs);
      entry.absoluteTimer = setTimeout(() => this.#promptTimedOut(id, true), this.promptAbsoluteTimeoutMs);
      this.pending.set(id, entry);
      try {
        this.child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "session/prompt",
          params: { sessionId, prompt: [{ type: "text", text }, ...attachments] },
        })}\n`);
        entry.dispatched = true;
      } catch (error) {
        this.pending.delete(id);
        this.#clearTimers(entry);
        reject(failure(`The prompt could not be sent: ${error.message}`, { dispatched: false, outcomeUnknown: false, prompt: true, fatal: true }));
      }
    });
    const result = await promise;
    await this.settleNotifications();
    const answer = this.notifications.slice(baseline)
      .filter((entry) => entry.sessionId === sessionId && entry.update?.sessionUpdate === "agent_message_chunk")
      .map((entry) => entry.update.content?.text ?? "")
      .join("");
    return { answer, stopReason: result.stopReason };
  }

  pausePromptTimers() {
    for (const entry of this.pending.values()) {
      if (!entry.prompt) continue;
      entry.paused = true;
      clearTimeout(entry.idleTimer);
    }
  }

  resumePromptTimers() {
    for (const entry of this.pending.values()) {
      if (!entry.prompt || !entry.paused) continue;
      entry.paused = false;
      clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => this.#promptTimedOut(entry.id), this.promptIdleTimeoutMs);
    }
  }

  cancel(sessionId) {
    if (!sessionId || !this.child?.stdin.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })}\n`);
    } catch {}
  }

  async ensureSession(sessionId, cwd) {
    await this.start();
    if (sessionId) {
      try {
        await this.request("session/load", { sessionId, cwd, mcpServers: [] });
        await this.settleNotifications();
        return sessionId;
      } catch (error) {
        if (!/not found/i.test(error.message)) throw error;
      }
    }
    const created = await this.request("session/new", { cwd, mcpServers: [] });
    await this.settleNotifications();
    return created.sessionId;
  }

  #signal(child, signal) {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    this.#rejectPending(failure("ACP client stopped.", { dispatched: true }));
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const grace = (milliseconds) => new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref();
    });
    this.#signal(child, "SIGTERM");
    await Promise.race([exited, grace(2_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      this.#signal(child, "SIGKILL");
      await Promise.race([exited, grace(2_000)]);
    }
  }
}
