import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
const EXTENSIONS = {
  "text/plain": new Set([".txt", ".md"]),
  "text/markdown": new Set([".md"]),
  "text/csv": new Set([".csv"]),
  "application/json": new Set([".json"]),
  "application/pdf": new Set([".pdf"]),
  "image/png": new Set([".png"]),
  "image/jpeg": new Set([".jpg", ".jpeg"]),
};
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = (content) => createHash("sha256").update(content).digest("hex");

export function allowedAttachmentTypes() {
  return Object.fromEntries(Object.entries(EXTENSIONS).map(([type, extensions]) => [type, [...extensions]]));
}

export function attachmentName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 120 || [".", ".."].includes(name) || /[\/\\\u0000-\u001f\u007f]/.test(name)) {
    throw problem("Attachment names must be 1–120 safe filename characters without paths.");
  }
  return name;
}

export function attachmentMediaType(name, value) {
  const mediaType = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!EXTENSIONS[mediaType]?.has(extname(name).toLowerCase())) {
    throw problem("Unsupported attachment type or filename extension. Use TXT, MD, CSV, JSON, PDF, PNG, or JPEG.");
  }
  return mediaType;
}

export function publicAttachment(attachment) {
  return {
    id: attachment.id,
    roomId: attachment.roomId,
    name: attachment.name,
    mediaType: attachment.mediaType,
    size: attachment.size,
    sha256: attachment.sha256,
    createdAt: attachment.createdAt,
    messageId: attachment.messageId ?? null,
  };
}

function validateContent(mediaType, content) {
  if (["text/plain", "text/markdown", "text/csv", "application/json"].includes(mediaType)) {
    try { new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { throw problem("Text attachments must contain valid UTF-8."); }
  } else if (mediaType === "application/pdf" && content.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw problem("The PDF attachment does not contain a valid PDF header.");
  } else if (mediaType === "image/png" && !content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw problem("The PNG attachment does not contain a valid PNG header.");
  } else if (mediaType === "image/jpeg" && (content.length < 3 || content[0] !== 0xff || content[1] !== 0xd8 || content[2] !== 0xff)) {
    throw problem("The JPEG attachment does not contain a valid JPEG header.");
  }
}

export function acpAttachmentBlock(attachment, content) {
  const uri = `openbot-hub://attachments/${attachment.id}/${encodeURIComponent(attachment.name)}`;
  const _meta = { attachmentId: attachment.id, fileName: attachment.name, sha256: attachment.sha256 };
  if (["text/plain", "text/markdown", "text/csv", "application/json"].includes(attachment.mediaType)) {
    return { type: "resource", resource: { uri, mimeType: attachment.mediaType, text: content.toString("utf8") }, _meta };
  }
  if (["image/png", "image/jpeg"].includes(attachment.mediaType)) {
    return { type: "image", data: content.toString("base64"), mimeType: attachment.mediaType, uri, _meta };
  }
  return { type: "resource", resource: { uri, mimeType: attachment.mediaType, blob: content.toString("base64") }, _meta };
}

export class AttachmentStore {
  constructor(root) {
    this.root = resolve(root);
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  path(id) {
    const path = resolve(this.root, id);
    if (!/^[-a-f0-9]{36}$/.test(id) || !path.startsWith(`${this.root}/`)) throw problem("Invalid attachment storage identity.");
    return path;
  }

  async save({ name, mediaType, body }) {
    const chunks = [];
    let size = 0;
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_ATTACHMENT_BYTES) throw problem("Attachment exceeds the 8 MiB limit.", 413);
      chunks.push(buffer);
    }
    if (!size) throw problem("Attachment content cannot be empty.");
    const content = Buffer.concat(chunks, size);
    validateContent(mediaType, content);
    const id = randomUUID();
    const path = this.path(id);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return { id, name, mediaType, size, sha256: digest(content), createdAt: new Date().toISOString(), path };
  }

  async read(attachment) {
    const content = await readFile(this.path(attachment.id));
    if (content.length !== attachment.size || digest(content) !== attachment.sha256) {
      throw problem("Attachment content failed its size or SHA-256 integrity check.", 409);
    }
    return content;
  }

  async remove(id) {
    await rm(this.path(id), { force: true });
  }
}
