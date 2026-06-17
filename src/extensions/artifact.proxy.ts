/**
 * Artifact proxy extension.
 *
 * Lets generated PI agents surface file/output artifacts directly in the chat
 * stream. The payload intentionally mirrors the main app's file renderer shape
 * (`file_url`, `file_name`, `file_type`) so the frontend can render cards and
 * previews without a separate artifact-management surface.
 */

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { SessionEventEmitter } from "@/session/session";

const ARTIFACT_TYPES = new Set([
  "DOCUMENT",
  "MARKDOWN",
  "TEXT",
  "PDF",
  "WORD_DOCUMENT",
  "SPREADSHEET",
  "CSV",
  "EXCEL",
  "IMAGE",
  "PHOTO",
  "DESIGN",
  "MOCKUP",
  "WIREFRAME",
  "DIAGRAM",
  "FLOORPLAN",
  "VIDEO",
  "AUDIO",
]);

type ArtifactParams = {
  type?: unknown;
  title?: unknown;
  file_url?: unknown;
  url?: unknown;
  file_name?: unknown;
  filename?: unknown;
  name?: unknown;
  file_type?: unknown;
  mime_type?: unknown;
  mimeType?: unknown;
  file_size?: unknown;
  sizeBytes?: unknown;
  preview_url?: unknown;
  content_preview?: unknown;
  content?: unknown;
  full_content?: unknown;
  spreadsheet_csv?: unknown;
  sheets?: unknown;
  workbook_sheets?: unknown;
  source?: unknown;
  metadata?: unknown;
};

export function createArtifactProxy(opts: {
  conversationId: string;
  emitter: SessionEventEmitter;
}): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "create_artifact",
      label: "Create Artifact",
      description:
        "Return a generated file or output artifact to the user in chat. Use this after creating an output such as a PDF, CSV, image, video, audio, markdown, or document. Provide a reachable file_url when the artifact is a file. For Excel/SPREADSHEET artifacts, provide complete CSV rows in content, full_content, or spreadsheet_csv, and keep content_preview short. For multi-sheet workbooks, pass sheets as an array of { name, rows } objects where rows is a 2D array including headers.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "Artifact type: DOCUMENT, MARKDOWN, TEXT, PDF, WORD_DOCUMENT, SPREADSHEET, CSV, EXCEL, IMAGE, PHOTO, DESIGN, MOCKUP, WIREFRAME, DIAGRAM, FLOORPLAN, VIDEO, or AUDIO.",
          },
          title: { type: "string", description: "Human-readable artifact title." },
          file_url: { type: "string", description: "Reachable URL for preview/download." },
          file_name: { type: "string", description: "Original or display file name." },
          file_type: { type: "string", description: "MIME type, for example application/pdf." },
          file_size: { type: "number", description: "Optional file size in bytes." },
          preview_url: { type: "string", description: "Optional preview URL if different from file_url." },
          content_preview: { type: "string", description: "Optional short text preview." },
          content: { type: "string", description: "Full artifact text content. For Excel/SPREADSHEET artifacts, provide complete CSV rows for the workbook download." },
          full_content: { type: "string", description: "Alias for full artifact content when content_preview is shortened." },
          spreadsheet_csv: { type: "string", description: "Complete CSV content for Excel/SPREADSHEET/CSV artifacts." },
          sheets: {
            type: "array",
            description: "For Excel/SPREADSHEET artifacts: array of worksheet objects, each with name and rows. rows must be a 2D array including the header row.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                rows: {
                  type: "array",
                  items: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
          workbook_sheets: { type: "array", description: "Alias for sheets." },
          source: { type: "string", description: "Optional source label." },
          metadata: { type: "object", description: "Optional structured metadata." },
        },
        required: ["type"],
      },
      async execute(_toolCallId: string, params: ArtifactParams) {
        const artifact = normalizeArtifact(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                message: `Artifact created: ${artifact.file_name || artifact.title || artifact.type}`,
                ...artifact,
                isError: false,
              }),
            },
          ],
          details: { artifact },
        };
      },
    });
  };
}

function normalizeArtifact(params: ArtifactParams) {
  const rawType = readString(params.type).toUpperCase();
  const type = ARTIFACT_TYPES.has(rawType) ? rawType : "DOCUMENT";
  const fileUrl = readString(params.file_url) || readString(params.url);
  const fileName =
    readString(params.file_name) ||
    readString(params.filename) ||
    readString(params.name) ||
    fileNameFromUrl(fileUrl) ||
    defaultFileName(type);
  const fileType =
    readString(params.file_type) ||
    readString(params.mime_type) ||
    readString(params.mimeType) ||
    mimeTypeFor(type, fileName);
  const createdAt = new Date().toISOString();
  const fullContent =
    readString(params.content) ||
    readString(params.full_content) ||
    readString(params.spreadsheet_csv);
  const metadata =
    params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
      ? { ...(params.metadata as Record<string, unknown>) }
      : {};
  if (fullContent && typeof metadata.content !== "string") {
    metadata.content = fullContent;
  }
  if (Array.isArray(params.sheets) && !Array.isArray(metadata.sheets)) {
    metadata.sheets = params.sheets;
  } else if (Array.isArray(params.workbook_sheets) && !Array.isArray(metadata.sheets)) {
    metadata.sheets = params.workbook_sheets;
  }

  return {
    id: crypto.randomUUID(),
    type,
    title: readString(params.title) || fileName,
    file_name: fileName,
    file_type: fileType,
    file_url: fileUrl,
    ...(readNumber(params.file_size) || readNumber(params.sizeBytes)
      ? { file_size: readNumber(params.file_size) || readNumber(params.sizeBytes) }
      : {}),
    ...(readString(params.preview_url) ? { preview_url: readString(params.preview_url) } : {}),
    ...(readString(params.content_preview) ? { content_preview: readString(params.content_preview) } : {}),
    source: readString(params.source) || "file",
    created_at: createdAt,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function fileNameFromUrl(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.split("/").filter(Boolean).pop();
    return name ? decodeURIComponent(name) : "";
  } catch {
    const name = url.split("?")[0]?.split("/").filter(Boolean).pop();
    return name ?? "";
  }
}

function defaultFileName(type: string): string {
  const extension = {
    MARKDOWN: "md",
    TEXT: "txt",
    PDF: "pdf",
    WORD_DOCUMENT: "docx",
    SPREADSHEET: "xlsx",
    CSV: "csv",
    EXCEL: "xlsx",
    IMAGE: "png",
    PHOTO: "png",
    VIDEO: "mp4",
    AUDIO: "mp3",
  }[type] ?? "dat";
  return `artifact-${Date.now()}.${extension}`;
}

function mimeTypeFor(type: string, fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf") || type === "PDF") return "application/pdf";
  if (lower.endsWith(".csv") || type === "CSV") return "text/csv";
  if (lower.endsWith(".md") || type === "MARKDOWN") return "text/markdown";
  if (lower.endsWith(".txt") || type === "TEXT") return "text/plain";
  if (lower.endsWith(".docx") || type === "WORD_DOCUMENT") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".xlsx") || type === "EXCEL" || type === "SPREADSHEET") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (lower.match(/\.(png|jpg|jpeg|webp|gif)$/) || type === "IMAGE" || type === "PHOTO") {
    return lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg" : "image/png";
  }
  if (lower.endsWith(".mp4") || type === "VIDEO") return "video/mp4";
  if (lower.endsWith(".mp3") || type === "AUDIO") return "audio/mpeg";
  return "application/octet-stream";
}
