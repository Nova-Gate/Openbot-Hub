import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(root, "runtime/demo");
const tokenPath = resolve(runtime, "token");
await mkdir(runtime, { recursive: true });
if (!existsSync(tokenPath)) await writeFile(tokenPath, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
await chmod(tokenPath, 0o600);

const node = spawn(process.execPath, [resolve(root, "connectors/remote-acp/node-server.mjs"), "--config", resolve(root, "config/node.demo.json")], {
  cwd: root,
  stdio: ["ignore", "pipe", "inherit"],
});
let app;
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (app?.exitCode === null && app.signalCode === null) app.kill("SIGTERM");
  if (node.exitCode === null && node.signalCode === null) node.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const ready = new Promise((resolveReady, reject) => {
  let buffer = "";
  node.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === "qenbet.listening") resolveReady(event);
      } catch {}
    }
  });
  node.once("exit", (code) => reject(new Error(`Execution node exited (${code}).`)));
});
await ready;
app = spawn(process.execPath, [resolve(root, "server/server.mjs"), ...process.argv.slice(2)], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
});
app.once("exit", (code) => {
  stop();
  process.exitCode = code ?? 0;
});
node.once("exit", () => {
  if (!stopping) stop();
});
