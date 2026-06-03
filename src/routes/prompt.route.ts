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

          // Subscribe BEFORE prompt so we don't miss early events.
          const unsubscribe = session.subscribe((event) => {
            // Forward raw Pi SDK events. pi-agent-server translates them.
            channel.send("pi_event", event);
          });

          try {
            await session.prompt(body.message);
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
