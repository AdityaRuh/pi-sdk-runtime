/**
 * Pi SDK session factory.
 *
 * Builds one AgentSession per conversation, bound to /workspace. Auth, models
 * and session files live under /agent-data so a single mounted volume holds
 * everything stateful.
 *
 * Extension wiring here is deliberately minimal. The SDK exposes its built-in
 * tools plus any tools registered by loaded extensions, including the gateway
 * UI proxies.
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
import { createArtifactProxy } from "@/extensions/artifact.proxy";
import { createSubagentProxy } from "@/extensions/subagent.proxy";
import { createGatewayUIContext } from "@/lib/ui-bridge";

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
  const artifactProxy = createArtifactProxy({ conversationId, emitter });
  const subagentProxy = createSubagentProxy({
    conversationId,
    emitter,
    parentDeps: {
      authStorage,
      modelRegistry,
      settingsManager,
      cwd: env.workspaceDir,
      agentDir: env.piAgentDir,
    },
  });

  const resourceLoader = new DefaultResourceLoader({
    agentDir: env.piAgentDir,
    cwd: env.workspaceDir,
    extensionFactories: [askUserProxy, approvalProxy, artifactProxy, subagentProxy],
    settingsManager,
    // Use the agent bundle's own .pi/APPEND_SYSTEM.md when present;
    // fall back to our generic system-pi.md only if it doesn't exist.
    // Toggle USE_AGENT_BUNDLE_PROMPT=false to force our prompt instead.
    ...(Bun.env.USE_AGENT_BUNDLE_PROMPT === "false"
      ? { systemPromptOverride: () => systemPrompt }
      : {}),
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
  });

  // Bridge Pi SDK's ExtensionUIContext to gateway SSE events.
  // After this call, `ctx.hasUI === true` and bundled extensions that use
  // ctx.ui.input / select / confirm route through `ask_user_start` events
  // and unblock via POST /ask-user/answer — same path our legacy proxy uses.
  session.extensionRunner.setUIContext(
    createGatewayUIContext({ conversationId, emitter }),
  );

  return session;
}
