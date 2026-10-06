# my-agent

A teaching-sized reimplementation of the Pi Agent runtime: an agent loop, safe
workspace tools, a JSONL session tree with compaction, an HTTP API, a React UI,
and a **provider layer** that talks to real OpenAI-compatible gateways.

The point of the project is to expose the machinery, not hide it. Every layer is
small enough to read in one sitting.

## Architecture

```
browser UI (React)  ──/api──▶  Express server
                                    │
                        runAgentLoop (agent/loop.ts)
                          │                    │
                    TeachingModel        ToolRegistry
                          │              (list/read/write_note)
                    ProviderRegistry
                          │
              ┌───────────┴────────────┐
        ApiAdapter                ResolvedModel
   (openai-completions, mock)  (baseUrl/key/contextWindow)
                          │
                JsonlSessionStore (.teaching-agent/session.jsonl)
```

The provider layer mirrors Pi's design in four parts:

| Pi | Here | Responsibility |
|---|---|---|
| `packages/ai/src/api/*` | `providers/api/*` (`ApiAdapter`) | Wire protocol only: convert messages/tools to HTTP and back |
| `Provider` object | `ProviderDefinition` | baseUrl, apiKey, headers, model list, which adapter |
| `models.json` + `ModelRegistry` | `providers.json` + `ProviderRegistry` | Declarative config, `$ENV`/`!command` interpolation, `resolve()` |
| `/model` selection | `ModelRuntime` + `/api/models` | List and switch the active model |

Because `loop.ts` only depends on the `TeachingModel` interface, adding a provider
never touches the loop, the session store, or the UI.

### Streaming

`TeachingModel` (and `ApiAdapter`) expose an optional `stream()` alongside
`complete()`. When present, the agent loop consumes it and emits incremental
`message_update` events; when absent, the loop falls back to a single `complete`
call. The OpenAI adapter parses SSE itself: text deltas, tool-call arguments
split across chunks, usage from the final chunk, `[DONE]`, and `:` heartbeats.

The UI calls `POST /api/prompt/stream` and renders assistant text as it arrives.

## Quick start

```bash
npm install
cp .env.example .env      # set MAGPIE_API_KEY if your gateway needs one
npm run dev               # API on :4317, web on :5174
```

Open http://localhost:5174 and try `列出工作区文件`, `读取 agent-notes.md`,
`帮我写一个笔记 demo.md`. Watch the Session Tree and Event Timeline on the right.

Scripts:

```bash
npm run dev        # api + web
npm run dev:server # api only (tsx watch)
npm run build      # vite build
npm run typecheck  # tsc --noEmit
npm test           # node:test suites (offline)
```

## Provider configuration

`providers.json` declares providers and their models. Secrets use interpolation:

- `$NAME` / `${NAME}` — read an environment variable
- `!command` — run a command once, cache its stdout (trusted config only)
- `$$` / `$!` — literal `$` / literal leading `!`

```json
{
  "defaultModel": "magpie/workbuddy-ai/deepseek-v4.1-flash",
  "providers": {
    "magpie": {
      "label": "Magpie Gateway",
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:3425/v1",
      "apiKey": "$MAGPIE_API_KEY",
      "models": [
        { "id": "workbuddy-ai/deepseek-v4.1-flash", "contextWindow": 1000000, "maxOutputTokens": 32000 }
      ]
    },
    "mock": {
      "api": "mock",
      "baseUrl": "mock://offline",
      "models": [{ "id": "mock", "label": "Mock Model" }]
    }
  }
}
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | API port |
| `PI_MODEL` | `providers.json` `defaultModel` | Model selected at startup |
| `PI_PROVIDERS_FILE` | `providers.json` | Alternate config path |
| `PI_COMPACT_TOKENS` | `contextWindow - 16384` | Force a low compaction threshold for demos |

The compaction threshold is derived from the resolved model's `contextWindow`
(leaving a 16k reserve, like Pi's `reserveTokens`), so switching models also
changes when context gets compacted.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/session` | Session context, events, tools, entries |
| `POST` | `/api/prompt` | Append a user message and run the agent loop |
| `POST` | `/api/prompt/stream` | Same, as server-sent events (`agent` frames + a final `done`) |
| `POST` | `/api/reset` | Clear the session |
| `GET` | `/api/models` | Available models + current selection |
| `POST` | `/api/model` | Switch the active model (`{ "ref": "provider/model" }`) |

## Adding a provider

1. If the service speaks a new wire protocol, add an `ApiAdapter` under
   `providers/api/` and register it in `createProviderRegistry()`.
2. Add the provider and its models to `providers.json`.
3. Done. The loop, API, and UI pick it up automatically.

## Testing against a live gateway

The offline suite is the default. Live tests are opt-in:

```bash
PI_LIVE_TEST=1 MAGPIE_API_KEY=magpie npm test
# or target just the live file:
PI_LIVE_TEST=1 MAGPIE_API_KEY=magpie npx tsx --test src/server/providers/live.test.ts
```

They verify a plain completion, a real tool call, and end-to-end resolution
through the registry against `PI_LIVE_BASE_URL` / `PI_LIVE_MODEL`.

## Layout

```
src/shared/protocol.ts            shared message/session/event types
src/server/agent/
  loop.ts                         the agent loop (context -> model -> tools -> next turn)
  model.ts                        TeachingModel interface (the model seam)
  mockModel.ts                    offline keyword-driven model
  message.ts                      message constructors and helpers
  tools.ts                        safe workspace tools + path sandbox
  sessionStore.ts                 JSONL session tree, buildContext, compaction
src/server/providers/
  types.ts                        ApiAdapter / ProviderDefinition / ResolvedModel
  interpolate.ts                  $NAME / !command secret resolution
  config.ts                       providers.json loading and validation
  registry.ts                     ProviderRegistry + ModelRuntime
  api/openaiCompletions.ts        OpenAI Chat Completions adapter
  api/mock.ts                     mock adapter
src/server/index.ts               Express app, /api routes, startup
src/client/App.tsx                React UI (chat, session tree, tools, events, model picker)
workspace/                        sandbox the tools operate on
providers.json                    provider/model configuration
```
