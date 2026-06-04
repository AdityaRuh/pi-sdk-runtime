/**
 * Ask-user proxy extension.
 *
 * Today builder-agent has a full ask-user registry. In a sandboxed runtime
 * the *user* is on the other side of the server. So we simply:
 *
 *   1. Emit an "ask_user_start" event when the agent calls the tool.
 *   2. Block on a resolver keyed by askId until pi-agent-server forwards
 *      the answer via POST /ask-user/answer.
 *   3. Emit "ask_user_end" and return the answer to the agent.
 *
 * The promise plumbing lives in session/registry.ts so the route handler
 * can flip the resolver from outside.
 */

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { awaitResolver } from "@/session/registry";
import type { SessionEventEmitter } from "@/session/session";

type AskUserAnswer = { answer: string; selected?: string };

export function createAskUserProxy(opts: {
  conversationId: string;
  emitter: SessionEventEmitter;
}): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "ask_user",
      label: "Ask User",
      description:
        "Ask the user a question. Blocks until the user answers. Use sparingly — only when you genuinely cannot proceed without input.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "What to ask the user." },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of choices to present.",
          },
        },
        required: ["question"],
      },
      async execute(_toolCallId: string, params: { question?: unknown; options?: unknown }) {
        const question = typeof params?.question === "string" ? params.question : "";
        const options = Array.isArray(params?.options)
          ? (params.options.filter((o) => typeof o === "string") as string[])
          : undefined;
        const askId = crypto.randomUUID();

        opts.emitter.emit("ask_user_start", {
          askId,
          question,
          options: options ?? [],
          conversationId: opts.conversationId,
        });

        try {
          const answer = await awaitResolver<AskUserAnswer>(
            opts.conversationId,
            askId,
          );
          opts.emitter.emit("ask_user_end", {
            askId,
            answer: answer.answer,
            selected: answer.selected,
            conversationId: opts.conversationId,
          });
          return {
            content: [{ type: "text", text: answer.answer }],
            details: { askId, answer: answer.answer, selected: answer.selected },
          };
        } catch (err) {
          opts.emitter.emit("ask_user_end", {
            askId,
            error: err instanceof Error ? err.message : String(err),
            conversationId: opts.conversationId,
          });
          throw err;
        }
      },
    });
  };
}
