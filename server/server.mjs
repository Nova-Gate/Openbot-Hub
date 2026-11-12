import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hub } from "./hub.mjs";
import { redactError } from "./redact.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = resolve(root, "web");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const exact = args.indexOf(`--${name}`);
  if (exact >= 0) return args[exact + 1];
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
};
const host = option("host", "127.0.0.1");
const port = Number(option("port", "7100"));
const statePath = resolve(root, option("state", "runtime/hub/state.json"));
const agentsPath = option("agents", null);
const approvalTimeoutMs = Number(option("approval-timeout-ms", "120000"));
if (!Number.isFinite(approvalTimeoutMs) || approvalTimeoutMs < 100) throw new Error("Approval timeout must be at least 100 ms.");
const agents = agentsPath ? JSON.parse(await readFile(resolve(root, agentsPath), "utf8")) : null;
if (agents !== null && !Array.isArray(agents)) throw new Error("Agent configuration must be a JSON array.");
const hub = new Hub({ root, statePath, agents, approvalTimeoutMs });
await hub.load();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const json = (response, status, value) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
};
const body = async (request) => {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw Object.assign(new Error("JSON content type is required."), { status: 415 });
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 32_768) throw Object.assign(new Error("Request is too large."), { status: 413 });
  }
  return JSON.parse(text || "{}");
};

const server = http.createServer(async (request, response) => {
  try {
    if (!request.headers.host) throw Object.assign(new Error("Host header is required."), { status: 403 });
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname)) {
      throw Object.assign(new Error("Foreign Host headers are not allowed."), { status: 403 });
    }
    if (request.headers["sec-fetch-site"] === "cross-site") {
      throw Object.assign(new Error("Cross-site requests are not allowed."), { status: 403 });
    }
    if (request.headers.origin) {
      let origin;
      try { origin = new URL(request.headers.origin).origin; } catch { origin = null; }
      if (origin !== `http://${request.headers.host}`) {
        throw Object.assign(new Error("Cross-origin requests are not allowed."), { status: 403 });
      }
    }
    if (url.pathname === "/api/state" && request.method === "GET") return json(response, 200, hub.snapshot());
    if (url.pathname === "/api/health" && request.method === "GET") {
      return json(response, 200, { ok: true, product: "OpenBot Hub", accounts: false, externalAnalytics: false });
    }
    const roomAttachmentMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/attachments$/);
    if (roomAttachmentMatch && request.method === "POST") {
      if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/octet-stream") {
        throw Object.assign(new Error("Binary attachment uploads require application/octet-stream."), { status: 415 });
      }
      let name;
      try { name = decodeURIComponent(request.headers["x-attachment-name"] ?? ""); } catch {
        throw Object.assign(new Error("Attachment name encoding is invalid."), { status: 400 });
      }
      const result = await hub.uploadAttachment(decodeURIComponent(roomAttachmentMatch[1]), {
        name,
        mediaType: request.headers["x-attachment-media-type"],
        clientAttachmentId: request.headers["x-client-attachment-id"],
        body: request,
      });
      return json(response, result.duplicate ? 200 : 201, result);
    }
    const attachmentContentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)\/content$/);
    if (attachmentContentMatch && request.method === "GET") {
      const { attachment, content } = await hub.attachmentContent(decodeURIComponent(attachmentContentMatch[1]));
      const encodedName = encodeURIComponent(attachment.name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      response.writeHead(200, {
        "Content-Type": attachment.mediaType,
        "Content-Length": content.length,
        "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(content);
      return;
    }
    if (url.pathname === "/api/messages" && request.method === "POST") {
      return json(response, 202, await hub.post(await body(request)));
    }
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      return json(response, 201, await hub.createRoom(await body(request)));
    }
    const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
    if (roomMatch && request.method === "PATCH") {
      return json(response, 200, await hub.updateRoom(decodeURIComponent(roomMatch[1]), await body(request)));
    }
    if (roomMatch && request.method === "DELETE") {
      return json(response, 200, await hub.removeRoom(decodeURIComponent(roomMatch[1]), url.searchParams.get("confirm")));
    }
    if (url.pathname === "/api/agents" && request.method === "POST") {
      return json(response, 201, await hub.createAgent(await body(request)));
    }
    const agentTestMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/test$/);
    if (agentTestMatch && request.method === "POST") {
      return json(response, 200, await hub.testAgent(decodeURIComponent(agentTestMatch[1])));
    }
    const executionMatch = url.pathname.match(/^\/api\/executions\/([^/]+)\/(stop|retry)$/);
    if (executionMatch && request.method === "POST") {
      const executionId = decodeURIComponent(executionMatch[1]);
      if (executionMatch[2] === "stop") return json(response, 200, await hub.stopExecution(executionId));
      return json(response, 202, await hub.retryExecution(executionId));
    }
    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (approvalMatch && request.method === "POST") {
      const input = await body(request);
      return json(response, 200, await hub.respondApproval(decodeURIComponent(approvalMatch[1]), input));
    }
    const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (agentMatch && request.method === "PATCH") {
      return json(response, 200, await hub.updateAgent(decodeURIComponent(agentMatch[1]), await body(request)));
    }
    if (agentMatch && request.method === "DELETE") {
      return json(response, 200, await hub.removeAgent(decodeURIComponent(agentMatch[1])));
    }
    if (url.pathname === "/api/events" && request.method === "GET") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write("event: change\ndata: ready\n\n");
      const remove = hub.onEvent((type) => response.write(`event: ${type}\ndata: update\n\n`));
      const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20_000);
      request.once("close", () => {
        clearInterval(heartbeat);
        remove();
      });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") return json(response, 404, { error: "Not found" });
    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const path = resolve(webRoot, requested);
    if (!path.startsWith(`${webRoot}/`)) return json(response, 403, { error: "Forbidden" });
    const content = await readFile(path);
    response.writeHead(200, {
      "Content-Type": mime[extname(path)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'",
    });
    response.end(content);
  } catch (error) {
    json(response, error.status ?? (error.code === "ENOENT" ? 404 : 500), { error: redactError(error.message) });
  }
});
server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(JSON.stringify({ type: "openbot-hub.ready", url: `http://${host}:${actualPort}/` }));
});
const stop = async () => {
  server.closeAllConnections();
  await hub.stop();
  server.close(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
