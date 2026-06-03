# pi-sdk-runtime (Image 1)

The PI SDK runtime container. Wraps [`@mariozechner/pi-coding-agent`] and exposes a tiny
internal HTTP+SSE API. **Not user-facing** — only `pi-agent-server` (Image 2)
should call it.

## Why this exists

Separating the SDK from the network façade means we can:

- Upgrade the Pi SDK without redeploying the server.
- Run multiple SDK images side by side (different versions, different agent
  types) behind one server.
- Keep the SDK image off the public network — it only listens on the internal
  pod/network and trusts a shared bearer token.

## API surface

All endpoints require `Authorization: Bearer <INTERNAL_SHARED_TOKEN>`.

| Method | Path                        | Purpose                                        |
| ------ | --------------------------- | ---------------------------------------------- |
| POST   | `/prompt`                   | Start a prompt; returns SSE stream of Pi events |
| POST   | `/interrupt`                | Abort an in-flight prompt                       |
| POST   | `/ask-user/answer`          | Forward a user answer to a blocked ask-user     |
| POST   | `/approval/answer`          | Forward an approval decision                    |
| GET    | `/status`                   | Liveness + active-run state                     |

The events emitted are **raw Pi SDK events** (`message_update`, etc.).
Translation to the gateway's FE event vocabulary is the responsibility of
`pi-agent-server`.

## Run locally

```sh
cp .env.example .env
bun install
bun run dev
```

Then in another terminal:

```sh
curl -N -X POST http://localhost:7000/prompt \
  -H "Authorization: Bearer change-me-in-prod" \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"c1","message":"What files are here?"}'
```

## Volumes

| Mount         | Purpose                                          |
| ------------- | ------------------------------------------------ |
| `/workspace`  | The agent's working directory (reads/writes here) |
| `/agent-data` | Pi auth.json / models.json / session files       |

## Repo layout

```
src/
  server.ts                  # Elysia bootstrap on PORT
  routes/
    prompt.route.ts          # 5 endpoints listed above
  session/
    session.ts               # createAgentSession wiring
    registry.ts              # active sessions keyed by conversationId
  extensions/
    ask-user.proxy.ts        # ask-user → SSE event, await answer
    approval.proxy.ts        # approval → SSE event, await answer
  lib/
    sse.ts                   # SSE encoding + heartbeats
    env.ts                   # Bun.env parsing
agent/
  system-pi.md               # baked-in default system prompt
```
