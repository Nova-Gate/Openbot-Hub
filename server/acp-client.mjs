import { spawn } from "node:child_process";
import { redactError } from "./redact.mjs";

export class AcpClient {
  constructor({ command, args, env = {}, cwd, requestTimeoutMs = 120_000, onRequest = null, onNotification = null }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.requestTimeoutMs = requestTimeoutMs;
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

  #rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
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
        this.#rejectPending(new Error(`ACP process failed: ${redactError(cause.message)}`));
      });
      child.stdin.once("error", (cause) => {
        this.#rejectPending(new Error(`ACP input failed: ${redactError(cause.message)}`));
      });
      child.once("exit", (code) => {
        if (child.pid && process.platform !== "win32") {
          try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
          const cleanup = setTimeout(() => {
            try { process.kill(-child.pid, "SIGKILL"); } catch {}
          }, 2_000);
          cleanup.unref();
        }
        this.#rejectPending(new Error(`ACP process exited (${code}): ${this.stderr}`));
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
        this.#rejectPending(new Error("ACP stream contained malformed JSON."));
        continue;
      }
      if (message.id !== undefined && message.method) {
        void this.#handleRequest(message);
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const error = new Error(redactError(`${message.error.code}: ${message.error.message}`));
          error.retrySafe = message.error.code === -32010;
          pending.reject(error);
        } else pending.resolve(message.result);
      } else if (message.method === "session/update") {
        this.#queueNotification(message.params);
      }
    }
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
    if (!this.child) throw new Error("ACP client is not running.");
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(redactError(`${method} timed out: ${this.stderr}`)));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
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

  async prompt(sessionId, text, attachments = []) {
    const baseline = this.notifications.length;
    const result = await this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }, ...attachments],
    });
    await this.settleNotifications();
    const answer = this.notifications.slice(baseline)
      .filter((entry) => entry.sessionId === sessionId && entry.update?.sessionUpdate === "agent_message_chunk")
      .map((entry) => entry.update.content?.text ?? "")
      .join("");
    return { answer, stopReason: result.stopReason };
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
    this.#rejectPending(new Error("ACP client stopped."));
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
