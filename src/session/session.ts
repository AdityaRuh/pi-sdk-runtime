/**
 * Pi SDK session factory.
 *
 * Builds one AgentSession per conversation, bound to /workspace. Auth, models
 * and session files live under /agent-data so a single mounted volume holds
 * everything stateful.
 *
 * Extension wiring here is deliberately minimal — the SDK's built-in tools
 * (read, bash, edit, write) plus the ask-user + approval proxies. Heavy
 * extensions (subagent, save-agent, validation, scaffold) are out of scope
 * for the MVP image; add them in a follow-up.
 */

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";

import { env } from "@/lib/env";
import { createAskUserProxy } from "@/extensions/ask-user.proxy";
import { createApprovalProxy } from "@/extensions/approval.proxy";

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "ask_user"] as const;

const join = (...parts: string[]) =>
  parts.join("/").replace(/\/+/g, "/");

async function loadSystemPrompt(): Promise<string> {
  try {
    return await Bun.file(env.systemPromptPath).text();
  } catch (err) {
    // Fall back to a tiny prompt so the image still boots without an override.
    return "You are a helpful PI agent. Use the available tools to assist the user.";
  }
}

export type SessionEventEmitter = {
  emit: (event: string, data: unknown) => void;
};

export async function createConversationSession(
  conversationId: string,
  emitter: SessionEventEmitter,
): Promise<AgentSession> {
  const systemPrompt = await loadSystemPrompt();

  const authStorage = AuthStorage.create(join(env.piAgentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(
    authStorage,
    join(env.piAgentDir, "models.json"),
  );
  const settingsManager = SettingsManager.create(
    env.workspaceDir,
    env.piAgentDir,
  );

  const askUserProxy = createAskUserProxy({ conversationId, emitter });
  const approvalProxy = createApprovalProxy({ conversationId, emitter });

  const resourceLoader = new DefaultResourceLoader({
    agentDir: env.piAgentDir,
    cwd: env.workspaceDir,
    extensionFactories: [askUserProxy, approvalProxy],
    settingsManager,
    systemPromptOverride: () => systemPrompt,
  });

  await resourceLoader.reload();

  const sessionsDir = join(env.piAgentDir, "sessions", conversationId);
  const sessionManager = SessionManager.create(env.workspaceDir, sessionsDir);

  const { session } = await createAgentSession({
    agentDir: env.piAgentDir,
    authStorage,
    cwd: env.workspaceDir,
    modelRegistry,
    resourceLoader,
    sessionManager,
    settingsManager,
    tools: [...DEFAULT_TOOLS],
  });

  return session;
}
