/**
 * Env reader. Centralises Bun.env access so the rest of the code never
 * reads process.env / Bun.env directly. Fails fast if a required var is
 * missing.
 */

function required(name: string): string {
  const value = Bun.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = Bun.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

export const env = {
  port: Number(optional("PORT", "7000")),
  host: optional("HOST", "0.0.0.0"),
  workspaceDir: optional("WORKSPACE_DIR", "/workspace"),
  piAgentDir: optional("PI_AGENT_DIR", "/agent-data"),
  systemPromptPath: optional("SYSTEM_PROMPT_PATH", "/app/agent/system-pi.md"),
  internalSharedToken: required("INTERNAL_SHARED_TOKEN"),
  logLevel: optional("LOG_LEVEL", "info"),
  // Attachment limits (per file). Images get passed to the model as
  // base64 ImageContent; documents get cached locally and read by the
  // bundled document_parse tool on demand.
  maxImageBytes: Number(optional("MAX_IMAGE_BYTES", "10485760")),         // 10 MB
  maxDocBytes: Number(optional("MAX_DOC_BYTES", "20971520")),             // 20 MB
  maxAttachmentsPerMessage: Number(optional("MAX_ATTACHMENTS_PER_MESSAGE", "10")),
} as const;
