/**
 * In-process registry of active Pi sessions keyed by conversationId.
 *
 * Why in-process: this image runs one Pi SDK per pod. If you need multi-pod
 * resumability, that's pi-agent-server's job (it owns the Redis-backed event
 * log). This file just tracks "is there a live AgentSession for this
 * conversation right now".
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";

type Entry = {
  session: AgentSession;
  /** Pending ask-user/approval resolvers, keyed by the request id. */
  pendingResolvers: Map<string, (answer: unknown) => void>;
};

const entries = new Map<string, Entry>();

export function registerSession(conversationId: string, session: AgentSession): void {
  entries.set(conversationId, { session, pendingResolvers: new Map() });
}

export function getSession(conversationId: string): AgentSession | undefined {
  return entries.get(conversationId)?.session;
}

export function unregisterSession(conversationId: string): void {
  entries.delete(conversationId);
}

export function hasSession(conversationId: string): boolean {
  return entries.has(conversationId);
}

export function listConversationIds(): string[] {
  return [...entries.keys()];
}

// ── Ask-user / approval round-trip plumbing ─────────────────────────────────

export function awaitResolver<T = unknown>(
  conversationId: string,
  requestId: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const entry = entries.get(conversationId);
    if (!entry) {
      reject(new Error(`No active session for conversation ${conversationId}`));
      return;
    }
    entry.pendingResolvers.set(requestId, resolve as (a: unknown) => void);
  });
}

export function fulfilResolver(
  conversationId: string,
  requestId: string,
  answer: unknown,
): boolean {
  const entry = entries.get(conversationId);
  if (!entry) return false;
  const resolver = entry.pendingResolvers.get(requestId);
  if (!resolver) return false;
  entry.pendingResolvers.delete(requestId);
  resolver(answer);
  return true;
}
