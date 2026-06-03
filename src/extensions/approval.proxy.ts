/**
 * Approval proxy extension.
 *
 * Same shape as ask-user.proxy but for risky tool calls / artifact gates.
 * Emits "approval_required" (matches the gateway's FE vocabulary) and waits
 * for pi-agent-server to POST /approval/answer with a decision.
 */

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { awaitResolver } from "@/session/registry";
import type { SessionEventEmitter } from "@/session/session";

type ApprovalDecision = { decision: "approve" | "reject" | "cancel"; reason?: string };

export function createApprovalProxy(opts: {
  conversationId: string;
  emitter: SessionEventEmitter;
}): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "approval_tool",
      description:
        "Request user approval before performing a sensitive action. Blocks until the user decides.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Short description of what requires approval.",
          },
          payload: {
            type: "object",
            description: "Optional structured details to show the user.",
          },
        },
        required: ["summary"],
      },
      async execute({ summary, payload }: { summary: string; payload?: unknown }) {
        const approvalId = crypto.randomUUID();

        opts.emitter.emit("approval_required", {
          id: approvalId,
          tool: "approval_tool",
          command: summary,
          payload: payload ?? null,
          timeout_ms: 1_740_000, // 29 minutes, matches the OpenClaw bridge default
          conversationId: opts.conversationId,
        });

        const decision = await awaitResolver<ApprovalDecision>(
          opts.conversationId,
          approvalId,
        );

        if (decision.decision === "approve") return "approved";
        if (decision.decision === "reject")
          return `rejected${decision.reason ? `: ${decision.reason}` : ""}`;
        return "cancelled";
      },
    });
  };
}
