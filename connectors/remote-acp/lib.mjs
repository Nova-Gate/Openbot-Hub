import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";

export async function readConfig(path) {
  const configPath = resolve(path);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const root = resolve(dirname(configPath), "..");
  const fromRoot = (value) => (value ? resolve(root, value) : value);
  return { ...config, configPath, root, fromRoot };
}

export async function readToken(path) {
  const token = (await readFile(path, "utf8")).trim();
  if (token.length < 32) throw new Error("The connector token must contain at least 32 characters.");
  return token;
}

export function tokensEqual(left, right) {
  const a = Buffer.from(left ?? "");
  const b = Buffer.from(right ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function jsonLine(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`);
}

export function textFromPrompt(prompt) {
  const blocks = Array.isArray(prompt) ? prompt : [];
  const texts = blocks.filter((block) => block?.type === "text" && typeof block.text === "string");
  return texts.at(-1)?.text ?? "";
}

export function attachmentsFromPrompt(prompt) {
  const blocks = Array.isArray(prompt) ? prompt : [];
  return blocks.filter((block) => block?._meta?.attachmentId).map((block) => {
    const id = block._meta.attachmentId;
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Attachment identity is invalid.");
    let content;
    if (block.type === "resource" && typeof block.resource?.text === "string") content = Buffer.from(block.resource.text, "utf8");
    else if (block.type === "resource" && typeof block.resource?.blob === "string") content = Buffer.from(block.resource.blob, "base64");
    else if (block.type === "image" && typeof block.data === "string") content = Buffer.from(block.data, "base64");
    else throw new Error("Attachment content block is invalid.");
    return { id, content };
  });
}
