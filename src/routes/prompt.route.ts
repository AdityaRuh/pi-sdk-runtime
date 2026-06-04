/**
 * The five internal endpoints pi-agent-server calls.
 *
 *   POST /prompt              → start a prompt; returns SSE stream of Pi events
 *   POST /interrupt           → abort an in-flight prompt
 *   POST /ask-user/answer     → unblock an ask_user tool call
 *   POST /approval/answer     → unblock an approval tool call
 *   GET  /status              → liveness + active sessions
 *
 * Auth: every request must carry `Authorization: Bearer <INTERNAL_SHARED_TOKEN>`.
 */

import { Elysia, t } from "elysia";
import { env } from "@/lib/env";
import { createSseChannel, SSE_HEADERS } from "@/lib/sse";
import {
  createConversationSession,
  type SessionEventEmitter,
} from "@/session/session";
import {
  fulfilResolver,
  getSession,
  hasSession,
  listConversationIds,
  registerSession,
  unregisterSession,
} from "@/session/registry";
import {
  AttachmentFetchError,
  AttachmentTooLargeError,
  UnsupportedAttachmentError,
  processAttachments,
} from "@/lib/attachment-processor";

function requireToken(headers: Record<string, string | undefined>): void {
  const auth = headers["authorization"];
  const expected = `Bearer ${env.internalSharedToken}`;
  if (auth !== expected) {
    throw new Error("unauthorized");
  }
}

export const promptRoute = new Elysia({ name: "prompt-routes" })
  // ── POST /prompt ─────────────────────────────────────────────────────────
  .post(
    "/prompt",
    async ({ body, headers }) => {
      requireToken(headers as Record<string, string | undefined>);

      const channel = createSseChannel();
      const emitter: SessionEventEmitter = {
        emit: (event, data) => channel.send(event, data),
      };

      // Run the prompt off the request thread so we can return the SSE
      // stream immediately.
      (async () => {
        try {
          let session = getSession(body.conversationId);
          if (!session) {
            session = await createConversationSession(
              body.conversationId,
              emitter,
            );
            registerSession(body.conversationId, session);
          }

          channel.send("run_start", {
            conversationId: body.conversationId,
            timestamp: new Date().toISOString(),
          });

          // Process attachments before subscribing/prompting. Failures
          // surface as `attachment_error` events; subsequent
          // ask_user/document_parse calls then operate on the cached
          // local paths. Pure pass-through when no attachments.
          let images: Awaited<ReturnType<typeof processAttachments>>["images"] = [];
          let promptSuffix = "";
          if (body.attachments && body.attachments.length > 0) {
            try {
              const processed = await processAttachments(body.attachments, {
                workspaceDir: env.workspaceDir,
                runId: body.conversationId,
                maxImageBytes: env.maxImageBytes,
                maxDocBytes: env.maxDocBytes,
                maxAttachmentsPerMessage: env.maxAttachmentsPerMessage,
              });
              images = processed.images;
              promptSuffix = processed.promptSuffix;
              if (processed.references.length > 0) {
                channel.send("attachments_processed", {
                  conversationId: body.conversationId,
                  count: processed.references.length,
                  images: processed.images.length,
                  documents: processed.references.filter((r) => r.kind === "document").length,
                  references: processed.references.map((r) => ({
                    id: r.id,
                    name: r.name,
                    kind: r.kind,
                    mimeType: r.mimeType,
                    sizeBytes: r.sizeBytes,
                  })),
                  timestamp: new Date().toISOString(),
                });
              }
            } catch (err) {
              const reason =
                err instanceof UnsupportedAttachmentError ? "unsupported" :
                err instanceof AttachmentTooLargeError ? "too-large" :
                err instanceof AttachmentFetchError ? "fetch-failed" :
                "processing-failed";
              channel.send("attachment_error", {
                reason,
                message: err instanceof Error ? err.message : String(err),
                attachment: (err as { attachment?: unknown }).attachment ?? null,
                timestamp: new Date().toISOString(),
              });
              channel.send("agent_end", {
                stop_reason: "attachment_error",
                timestamp: new Date().toISOString(),
              });
              channel.close();
              return;
            }
          }

          // Subscribe BEFORE prompt so we don't miss early events.
          const unsubscribe = session.subscribe((event) => {
            // Forward raw Pi SDK events. pi-agent-server translates them.
            channel.send("pi_event", event);
          });

          try {
            const finalMessage = promptSuffix ? `${body.message}${promptSuffix}` : body.message;
            const promptOpts = images.length > 0 ? { images } : undefined;
            await session.prompt(finalMessage, promptOpts);
          } finally {
            unsubscribe();
          }

          channel.send("agent_end", {
            stop_reason: "completed",
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          channel.send("error", {
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          });
        } finally {
          channel.close();
        }
      })();

      return new Response(channel.stream, { headers: SSE_HEADERS });
    },
    {
      body: t.Object({
        conversationId: t.String({ minLength: 1 }),
        message: t.String({ minLength: 1 }),
        attachments: t.Optional(t.Array(t.Object({
          url: t.String({ minLength: 1 }),
          mimeType: t.String({ minLength: 1 }),
          name: t.String({ minLength: 1 }),
          sizeBytes: t.Optional(t.Number({ minimum: 0 })),
        }))),
      }),
    },
  )

  // ── POST /interrupt ──────────────────────────────────────────────────────
  .post(
    "/interrupt",
    ({ body, headers, set }) => {
      requireToken(headers as Record<string, string | undefined>);
      const session = getSession(body.conversationId);
      if (!session) {
        set.status = 404;
        return { ok: false, reason: "no active session" };
      }
      // Pi SDK's AgentSession exposes an abort method; if not available on
      // your installed version, this becomes a soft no-op.
      const maybeAbort = (session as unknown as { abort?: () => void }).abort;
      if (typeof maybeAbort === "function") maybeAbort.call(session);
      unregisterSession(body.conversationId);
      return { ok: true };
    },
    {
      body: t.Object({ conversationId: t.String({ minLength: 1 }) }),
    },
  )

  // ── POST /ask-user/answer ────────────────────────────────────────────────
  .post(
    "/ask-user/answer",
    ({ body, headers, set }) => {
      requireToken(headers as Record<string, string | undefined>);
      const ok = fulfilResolver(body.conversationId, body.askId, {
        answer: body.answer,
        selected: body.selected,
      });
      if (!ok) {
        set.status = 404;
        return { ok: false, reason: "no pending ask-user" };
      }
      return { ok: true };
    },
    {
      body: t.Object({
        conversationId: t.String({ minLength: 1 }),
        askId: t.String({ minLength: 1 }),
        answer: t.String(),
        selected: t.Optional(t.String()),
      }),
    },
  )

  // ── POST /approval/answer ────────────────────────────────────────────────
  .post(
    "/approval/answer",
    ({ body, headers, set }) => {
      requireToken(headers as Record<string, string | undefined>);
      const ok = fulfilResolver(body.conversationId, body.approvalId, {
        decision: body.decision,
        reason: body.reason,
      });
      if (!ok) {
        set.status = 404;
        return { ok: false, reason: "no pending approval" };
      }
      return { ok: true };
    },
    {
      body: t.Object({
        conversationId: t.String({ minLength: 1 }),
        approvalId: t.String({ minLength: 1 }),
        decision: t.Union([
          t.Literal("approve"),
          t.Literal("reject"),
          t.Literal("cancel"),
        ]),
        reason: t.Optional(t.String()),
      }),
    },
  )

  // ── POST /steer ──────────────────────────────────────────────────────────
  // Inject extra context into a currently-streaming session without
  // restarting the run. Maps to Pi SDK's session.steer().
  .post(
    "/steer",
    async ({ body, headers, set }) => {
      requireToken(headers as Record<string, string | undefined>);
      const session = getSession(body.conversationId);
      if (!session) {
        set.status = 404;
        return { ok: false, reason: "no active session" };
      }
      const steerFn = (session as unknown as { steer?: (t: string) => Promise<void> }).steer;
      if (typeof steerFn !== "function") {
        set.status = 501;
        return { ok: false, reason: "steer not supported by this Pi SDK version" };
      }
      await steerFn.call(session, body.text);
      return { ok: true };
    },
    {
      body: t.Object({
        conversationId: t.String({ minLength: 1 }),
        text: t.String({ minLength: 1 }),
      }),
    },
  )

  // ── POST /follow-up ──────────────────────────────────────────────────────
  // Queue a follow-up prompt to run after the current turn completes.
  .post(
    "/follow-up",
    async ({ body, headers, set }) => {
      requireToken(headers as Record<string, string | undefined>);
      const session = getSession(body.conversationId);
      if (!session) {
        set.status = 404;
        return { ok: false, reason: "no active session" };
      }
      const followUpFn = (session as unknown as { followUp?: (t: string) => Promise<void> }).followUp;
      if (typeof followUpFn !== "function") {
        set.status = 501;
        return { ok: false, reason: "followUp not supported by this Pi SDK version" };
      }
      await followUpFn.call(session, body.text);
      return { ok: true };
    },
    {
      body: t.Object({
        conversationId: t.String({ minLength: 1 }),
        text: t.String({ minLength: 1 }),
      }),
    },
  )

  // ── POST /model ──────────────────────────────────────────────────────────
  // Switch model mid-conversation. Empty `modelId` triggers cycleModel().
  .post(
    "/model",
    async ({ body, headers, set }) => {
      requireToken(headers as Record<string, string | undefined>);
      const session = getSession(body.conversationId);
      if (!session) {
        set.status = 404;
        return { ok: false, reason: "no active session" };
      }
      const sessAny = session as unknown as {
        setModel?: (m: unknown) => Promise<void>;
        cycleModel?: () => Promise<unknown>;
        model?: { id?: string };
      };
      if (body.modelId) {
        if (typeof sessAny.setModel !== "function") {
          set.status = 501;
          return { ok: false, reason: "setModel not available" };
        }
        await sessAny.setModel.call(session, { id: body.modelId, provider: body.provider });
      } else if (typeof sessAny.cycleModel === "function") {
        await sessAny.cycleModel.call(session);
      } else {
        set.status = 501;
        return { ok: false, reason: "cycleModel not available" };
      }
      return { ok: true, model: sessAny.model?.id ?? null };
    },
    {
      body: t.Object({
        conversationId: t.String({ minLength: 1 }),
        modelId: t.Optional(t.String()),
        provider: t.Optional(t.String()),
      }),
    },
  )

  // ── POST /thinking-level ─────────────────────────────────────────────────
  // Set or cycle the thinking depth on the current session.
  .post(
    "/thinking-level",
    ({ body, headers, set }) => {
      requireToken(headers as Record<string, string | undefined>);
      const session = getSession(body.conversationId);
      if (!session) {
        set.status = 404;
        return { ok: false, reason: "no active session" };
      }
      const sessAny = session as unknown as {
        setThinkingLevel?: (l: string) => void;
        cycleThinkingLevel?: () => string | undefined;
        thinkingLevel?: string;
      };
      if (body.level) {
        if (typeof sessAny.setThinkingLevel !== "function") {
          set.status = 501;
          return { ok: false, reason: "setThinkingLevel not available" };
        }
        sessAny.setThinkingLevel.call(session, body.level);
      } else if (typeof sessAny.cycleThinkingLevel === "function") {
        sessAny.cycleThinkingLevel.call(session);
      } else {
        set.status = 501;
        return { ok: false, reason: "cycleThinkingLevel not available" };
      }
      return { ok: true, level: sessAny.thinkingLevel ?? null };
    },
    {
      body: t.Object({
        conversationId: t.String({ minLength: 1 }),
        level: t.Optional(t.String({ description: "off | low | medium | high" })),
      }),
    },
  )

  // ── GET /status ──────────────────────────────────────────────────────────
  .get("/status", ({ headers }) => {
    requireToken(headers as Record<string, string | undefined>);
    return {
      ok: true,
      activeConversations: listConversationIds(),
      workspaceDir: env.workspaceDir,
      piAgentDir: env.piAgentDir,
    };
  });
