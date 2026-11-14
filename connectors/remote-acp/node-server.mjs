import net from "node:net";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { readConfig, readToken, tokensEqual, jsonLine } from "./lib.mjs";

const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
if (configIndex < 0 || !args[configIndex + 1]) {
  throw new Error("Usage: node-server.mjs --config <node-config.json>");
}
const config = await readConfig(args[configIndex + 1]);
const token = await readToken(config.fromRoot(config.tokenFile));
const agents = new Map(config.agents.map((agent) => [agent.agentId, agent]));

async function accept(socket) {
  socket.setEncoding("utf8");
  let buffer = "";
  const handshake = await new Promise((resolve) => {
    const onData = (chunk) => {
      buffer += chunk;
      if (buffer.length > 16_384) {
        socket.destroy();
        resolve(null);
        return;
      }
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      socket.off("data", onData);
      try {
        resolve(JSON.parse(buffer.slice(0, index)));
      } catch {
        resolve(null);
      }
    };
    socket.on("data", onData);
    socket.once("error", () => resolve(null));
  });
  if (!handshake || handshake.type !== "qenbet.connect" || handshake.version !== 2) {
    jsonLine(socket, { type: "qenbet.error", message: "Invalid connector handshake" });
    socket.end();
    return;
  }
  const agent = agents.get(handshake.agentId);
  if (!agent || !tokensEqual(handshake.token, token)) {
    jsonLine(socket, { type: "qenbet.error", message: "Unknown agent or invalid credential" });
    socket.end();
    return;
  }

  const workspace = join(config.fromRoot(config.workspaceRoot), agent.agentId);
  const stateRoot = join(config.fromRoot(config.stateRoot), agent.agentId);
  await mkdir(workspace, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  const child = spawn(process.execPath, [config.fromRoot(agent.command)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      QENBET_NODE_ID: config.nodeId,
      QENBET_AGENT_TITLE: agent.title,
      QENBET_WORKSPACE: workspace,
      QENBET_STATE_ROOT: stateRoot,
    },
  });
  jsonLine(socket, { type: "qenbet.ready", nodeId: config.nodeId, hostname: hostname() });
  socket.removeAllListeners("data");
  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
  child.stderr.on("data", (data) => {
    process.stderr.write(`[${config.nodeId}/${agent.agentId}] ${data.toString("utf8")}`);
  });
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  socket.once("close", stop);
  socket.once("error", stop);
  child.once("close", () => socket.end());
}

const server = net.createServer((socket) => {
  accept(socket).catch((error) => {
    process.stderr.write(`Qenbet node error: ${error.message}\n`);
    socket.destroy();
  });
});
server.listen(config.listenPort, config.listenHost, () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({
    type: "qenbet.listening",
    nodeId: config.nodeId,
    host: config.listenHost,
    port: typeof address === "object" && address ? address.port : config.listenPort,
  })}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
