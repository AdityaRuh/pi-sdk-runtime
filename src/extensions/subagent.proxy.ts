/**
 * Sub-agent extension.
 *
 * Registers a `subagent` tool that the main agent can call to delegate a
 * focused task to a child AgentSession. The child gets its own message
 * history, runs in the same workspace, and its events are forwarded to
 * the parent stream as `subagent_*` SSE events.
 *
 * MVP scope:
 *   - one tool call = one child session
 *   - shares parent's authStorage / modelRegistry / settingsManager / cwd
 *   - inherits parent's model selection (no per-subagent model override yet)
 *   - in-memory only; no batch persistence
 *
 * NOT yet:
 *   - runtime-specific subagent definitions (openclaw-agent, pi-agent, ...)
 *   - batch state files
 *   - hot-reload of definitions
 *   - parallel batches (current call is sequential)
 *
 * See openclaw-builder-agent/src/agent/subagent.extension.ts for the
 * full reference (782 LoC) — port the missing pieces as needs surface.
 */

import {
  type AuthStorage,
  type ExtensionFactory,
  type ModelRegistry,
  type SettingsManager,
  SessionManager,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { SessionEventEmitter } from "@/session/session";

export interface SubagentProxyOptions {
  conversationId: string;
  emitter: SessionEventEmitter;
  parentDeps: {
    authStorage: AuthStorage;
    modelRegistry: ModelRegistry;
    settingsManager: SettingsManager;
    cwd: string;
    agentDir: string;
  };
}

const SUBAGENT_DEFAULT_TOOLS = ["read", "write", "edit", "bash", "glob", "grep", "ls"];

export function createSubagentProxy(opts: SubagentProxyOptions): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "subagent",
      description:
        "Delegate a focused task to a sub-agent. The sub-agent runs in the same workspace with file + shell tools and returns its final response. Use for plan/execute/test sub-tasks that benefit from a fresh context.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "What the sub-agent should accomplish.",
          },
          name: {
            type: "string",
            description: "Optional human-readable label for this sub-agent.",
          },
        },
        required: ["task"],
      },
      async execute({ task, name }: { task: string; name?: string }) {
        const subagentId = crypto.randomUUID();
        const label = name?.trim() || "subagent";
        const startedAt = new Date().toISOString();

        opts.emitter.emit("subagent_start", {
          subagentId,
          name: label,
          task,
          conversationId: opts.conversationId,
          timestamp: startedAt,
        });

        let finalText = "";
        try {
          // Each sub-agent gets an in-memory session — we don't persist
          // sub-agent transcripts in the MVP. Bump to SessionManager.create
          // with a per-subagent dir when you need replay.
          const { session: child } = await createAgentSession({
            agentDir: opts.parentDeps.agentDir,
            authStorage: opts.parentDeps.authStorage,
            cwd: opts.parentDeps.cwd,
            modelRegistry: opts.parentDeps.modelRegistry,
            settingsManager: opts.parentDeps.settingsManager,
            sessionManager: SessionManager.inMemory(),
            tools: SUBAGENT_DEFAULT_TOOLS,
          });

          // Forward every child event upstream as `subagent_*` so the
          // gateway/FE can render nested progress.
          const unsubscribe = child.subscribe((event) => {
            opts.emitter.emit("subagent_event", {
              subagentId,
              name: label,
              event,
              conversationId: opts.conversationId,
            });

            // Best-effort accumulation of the child's final text reply.
            const inner = (event as { assistantMessageEvent?: { type?: string; delta?: string } })
              .assistantMessageEvent;
            if (inner?.type === "text_delta" && typeof inner.delta === "string") {
              finalText += inner.delta;
            }
          });

          try {
            await child.prompt(task);
          } finally {
            unsubscribe();
          }

          opts.emitter.emit("subagent_end", {
            subagentId,
            name: label,
            status: "completed",
            output: finalText,
            conversationId: opts.conversationId,
            timestamp: new Date().toISOString(),
          });

          return finalText || "(sub-agent produced no output)";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          opts.emitter.emit("subagent_end", {
            subagentId,
            name: label,
            status: "failed",
            error: message,
            conversationId: opts.conversationId,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
      },
    });
  };
}
