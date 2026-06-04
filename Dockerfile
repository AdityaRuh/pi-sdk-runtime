# ─────────────────────────────────────────────────────────────────────────────
# pi-sdk-runtime — Image 1
# Wraps @mariozechner/pi-coding-agent. Exposes an internal HTTP+SSE API on
# :7000. Only callable from pi-agent-server (Image 2).
# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

FROM oven/bun:1.1-alpine AS runner
WORKDIR /app

# Pi SDK shells out to `npm` to resolve `npm:<pkg>` entries in
# .pi/settings.json (e.g. the johnny-linear-279 agent declares
# `npm:pi-web-access`). Bun isn't a drop-in CLI replacement here, so we
# install nodejs + npm alongside Bun. Adds ~50 MB; well worth it for
# full Pi SDK compatibility.
#
# poppler-utils provides `pdftotext` and pandoc provides Office-format
# conversion. The bundled `document_parse` extension in new-style PI
# agents (post AB-XXX) shells out to these via `pi.exec`.
RUN apk add --no-cache nodejs npm poppler-utils pandoc

# Copy installed deps from the deps stage.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json

# Copy source + baked agent assets.
COPY src ./src
COPY agent ./agent
COPY tsconfig.json ./tsconfig.json

# Workspace + agent-data are mounted at runtime; create the mount points so
# the SDK doesn't crash on a missing dir if the operator forgets.
RUN mkdir -p /workspace /agent-data

EXPOSE 7000
ENV NODE_ENV=production
ENV PORT=7000
# `bun install @mariozechner/pi-coding-agent` drops the Pi CLI at
# /app/node_modules/.bin/pi. Put that on PATH so new-style PI agents
# (post AB-570) whose bundled subagent module calls `pi.exec("pi", ...)`
# can resolve it. Without this, subagent calls fail with ENOENT.
ENV PATH="/app/node_modules/.bin:${PATH}"

# Non-root for safety.
RUN addgroup -S piuser && adduser -S piuser -G piuser
RUN chown -R piuser:piuser /workspace /agent-data
USER piuser

CMD ["bun", "src/server.ts"]
