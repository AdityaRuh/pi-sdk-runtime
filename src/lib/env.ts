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
} as const;
