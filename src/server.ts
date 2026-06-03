/**
 * Entry point. Boots Elysia on PORT and mounts the prompt routes.
 *
 * Designed to be supervised by a container runtime (Docker / K8s) — SIGTERM
 * triggers a graceful shutdown.
 */

import { Elysia } from "elysia";
import { env } from "@/lib/env";
import { promptRoute } from "@/routes/prompt.route";

const app = new Elysia({ name: "pi-sdk-runtime" })
  .onError(({ error, set }) => {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === "unauthorized") {
      set.status = 401;
      return { error: { code: "unauthorized", message: "bad token" } };
    }
    set.status = 500;
    return { error: { code: "internal", message: msg } };
  })
  .get("/healthz", () => ({ ok: true }))
  .use(promptRoute)
  .listen({ port: env.port, hostname: env.host });

const banner = `pi-sdk-runtime listening on http://${env.host}:${env.port}`;
// biome-ignore lint/suspicious/noConsoleLog: boot banner
console.log(banner);

function shutdown(signal: string) {
  // biome-ignore lint/suspicious/noConsoleLog: shutdown banner
  console.log(`[pi-sdk-runtime] ${signal} received, stopping`);
  app.stop();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
