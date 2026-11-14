import net from "node:net";
import { readConfig, readToken, jsonLine } from "./lib.mjs";

const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
if (configIndex < 0 || !args[configIndex + 1]) {
  throw new Error("Usage: proxy.mjs --config <agent-config.json>");
}
const config = await readConfig(args[configIndex + 1]);
const token = await readToken(config.fromRoot(config.tokenFile));
const socket = net.createConnection({ host: config.host, port: config.port });

socket.once("connect", () => {
  jsonLine(socket, {
    type: "qenbet.connect",
    version: 2,
    agentId: config.agentId,
    token,
  });
});

socket.once("data", (chunk) => {
  const text = chunk.toString("utf8");
  const line = text.split("\n")[0];
  let ready;
  try {
    ready = JSON.parse(line);
  } catch {
    process.stderr.write("Qenbet node returned an invalid handshake.\n");
    socket.destroy();
    process.exitCode = 1;
    return;
  }
  if (ready.type !== "qenbet.ready") {
    process.stderr.write(`Qenbet connection refused: ${ready.message ?? "unknown error"}\n`);
    socket.destroy();
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`Qenbet connected: agent=${config.agentId} node=${ready.nodeId} host=${ready.hostname}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});

socket.on("error", (error) => {
  process.stderr.write(`Qenbet proxy error: ${error.message}\n`);
  process.exitCode = 1;
});
socket.on("close", () => process.stdin.destroy());
process.stdin.on("error", () => socket.destroy());
