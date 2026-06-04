/**
 * Attachment processor for incoming /prompt requests.
 *
 * Input: `attachments: Array<{url, mimeType, name, sizeBytes?}>` from the
 * gateway (forwarded by pi-agent-server).
 *
 * Behavior:
 *   - Download each URL to /workspace/attachments/<runId>/<id>-<name>.
 *   - Detect MIME (caller hint → Content-Type → extension fallback).
 *   - Classify:
 *       image/{png,jpeg,webp,gif}      → bytes → base64 → PromptOptions.images
 *       application/pdf                → leave on disk, mention in prompt
 *       Office formats (docx/xlsx/...) → leave on disk, mention in prompt
 *       text/*                         → leave on disk, mention in prompt
 *       anything else                  → throw UnsupportedAttachmentError
 *   - Size cap per file (separate for image vs doc).
 *   - Count cap per message.
 *
 * Output: { images, references, promptSuffix }
 *   - images        passed straight to session.prompt(text, { images })
 *   - references    bookkeeping; useful for SSE events if we surface them
 *   - promptSuffix  appended to the user message so the agent knows the
 *                   local paths exist (the bundled `document_parse` tool
 *                   then reads them on demand).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

// Pi SDK's PromptOptions.images is ImageContent[] from @mariozechner/pi-ai.
// We re-declare the structural shape locally so we don't depend on the
// upstream type-export topology, but field names must match
// (`mimeType`, not `mediaType`).
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

const DOWNLOAD_TIMEOUT_MS = 30_000;

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  "text/csv",
  "text/tab-separated-values",
  "text/markdown",
  "text/x-markdown",
  "text/plain",
  "text/yaml",
  "text/x-yaml",
  "application/yaml",
  "application/json",
]);

const EXTENSION_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rtf": "application/rtf",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".json": "application/json",
};

export interface IncomingAttachment {
  url: string;
  mimeType: string;
  name: string;
  sizeBytes?: number;
}

export interface AttachmentReference {
  id: string;
  url: string;
  name: string;
  mimeType: string;
  localPath: string;
  kind: "image" | "document";
  sizeBytes: number;
}

export interface ProcessedAttachments {
  images: ImageContent[];
  references: AttachmentReference[];
  promptSuffix: string;
}

export interface ProcessAttachmentOptions {
  workspaceDir: string;
  runId: string;
  maxImageBytes: number;
  maxDocBytes: number;
  maxAttachmentsPerMessage: number;
}

export class UnsupportedAttachmentError extends Error {
  override name = "UnsupportedAttachmentError";
  constructor(
    public attachment: IncomingAttachment,
    public detectedMime: string,
  ) {
    super(
      `Unsupported attachment type "${detectedMime}" for "${attachment.name}". ` +
      `Supported: PNG/JPEG/WebP/GIF images; PDF/DOC/DOCX/XLS/XLSX/PPT/PPTX/RTF/CSV/TSV/MD/TXT/YAML/JSON documents.`,
    );
  }
}

export class AttachmentTooLargeError extends Error {
  override name = "AttachmentTooLargeError";
  constructor(
    public attachment: IncomingAttachment,
    public sizeBytes: number,
    public maxBytes: number,
  ) {
    super(`Attachment "${attachment.name}" is ${sizeBytes} bytes; max allowed is ${maxBytes} bytes.`);
  }
}

export class AttachmentFetchError extends Error {
  override name = "AttachmentFetchError";
  constructor(
    public attachment: IncomingAttachment,
    public reason: string,
  ) {
    super(`Failed to download "${attachment.name}": ${reason}`);
  }
}

const sanitizeFileName = (name: string): string => {
  const cleaned = name.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "attachment";
};

const inferMimeType = (
  input: IncomingAttachment,
  headerContentType: string | null,
): string => {
  const declared = input.mimeType?.split(";")[0]?.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream") return declared;
  const header = headerContentType?.split(";")[0]?.trim().toLowerCase();
  if (header && header !== "application/octet-stream") return header;
  const extFromName = EXTENSION_MIME_TYPES[extname(input.name).toLowerCase()];
  if (extFromName) return extFromName;
  try {
    const u = new URL(input.url);
    const extFromUrl = EXTENSION_MIME_TYPES[extname(u.pathname).toLowerCase()];
    if (extFromUrl) return extFromUrl;
  } catch {
    // not a parsable URL — fall through
  }
  return declared || "application/octet-stream";
};

const isImageMime = (mime: string) => IMAGE_MIME_TYPES.has(mime);
const isDocumentMime = (mime: string) =>
  DOCUMENT_MIME_TYPES.has(mime) || mime.startsWith("text/");

const renderPromptSuffix = (docs: AttachmentReference[]): string => {
  if (docs.length === 0) return "";
  const lines = docs.map((d, i) => {
    return `${i + 1}. ${d.name}\n   Local path: ${d.localPath}\n   MIME type: ${d.mimeType}`;
  });
  return [
    "",
    "",
    "Attached files have been downloaded and cached locally. Use only the local paths below as the source of truth for these attachments.",
    "For non-image documents, call the `document_parse` tool on the local path when you need the contents. Do not call `web_search`, `web_fetch`, or the original URL for attached files.",
    "",
    ...lines,
  ].join("\n");
};

export async function processAttachments(
  attachments: IncomingAttachment[],
  opts: ProcessAttachmentOptions,
): Promise<ProcessedAttachments> {
  if (!attachments || attachments.length === 0) {
    return { images: [], references: [], promptSuffix: "" };
  }
  if (attachments.length > opts.maxAttachmentsPerMessage) {
    throw new Error(
      `Too many attachments: ${attachments.length} (max ${opts.maxAttachmentsPerMessage} per message).`,
    );
  }

  const attachmentsDir = join(opts.workspaceDir, "attachments", opts.runId);
  await mkdir(attachmentsDir, { recursive: true });

  const images: ImageContent[] = [];
  const references: AttachmentReference[] = [];

  for (const att of attachments) {
    if (!att.url) {
      throw new AttachmentFetchError(att, "missing url");
    }
    let response: Response;
    try {
      response = await fetch(att.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (err) {
      throw new AttachmentFetchError(att, err instanceof Error ? err.message : String(err));
    }
    if (!response.ok) {
      throw new AttachmentFetchError(att, `HTTP ${response.status} ${response.statusText}`);
    }
    const contentType = response.headers.get("content-type");
    const mime = inferMimeType(att, contentType);

    const bytes = Buffer.from(await response.arrayBuffer());
    if (isImageMime(mime) && bytes.byteLength > opts.maxImageBytes) {
      throw new AttachmentTooLargeError(att, bytes.byteLength, opts.maxImageBytes);
    }
    if (!isImageMime(mime) && bytes.byteLength > opts.maxDocBytes) {
      throw new AttachmentTooLargeError(att, bytes.byteLength, opts.maxDocBytes);
    }

    const fileId = crypto.randomUUID().slice(0, 8);
    const safeName = sanitizeFileName(att.name);
    const localPath = join(attachmentsDir, `${fileId}-${safeName}`);
    await writeFile(localPath, bytes);

    const reference: AttachmentReference = {
      id: crypto.randomUUID(),
      url: att.url,
      name: att.name,
      mimeType: mime,
      localPath,
      kind: isImageMime(mime) ? "image" : "document",
      sizeBytes: bytes.byteLength,
    };

    if (isImageMime(mime)) {
      images.push({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: mime as ImageContent["mimeType"],
      });
      references.push(reference);
    } else if (isDocumentMime(mime)) {
      references.push(reference);
    } else {
      throw new UnsupportedAttachmentError(att, mime);
    }
  }

  const docs = references.filter((r) => r.kind === "document");
  return { images, references, promptSuffix: renderPromptSuffix(docs) };
}
