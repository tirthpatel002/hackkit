<!-- Source: Grok Page "Shared pieces: detailed spec and build plan" (final version, 27 Oct 2026). This file is the build reference for hackkit. -->

# hackkit: spec and build plan

_Project-agnostic model connector (`@hackkit/connector`) and test harness (`@hackkit/harness`) in one pnpm workspace._

Repo notes:

- Private on GitHub `tirthpatel002` during the build; MIT `LICENSE` is already in the repo for when it goes public.
- Keys are read only from a git-ignored `.env` (names in `.env.example`). Tests use mocked HTTP / fakes; live tests need `LIVE=1` and the keys.
- Tooling pins: pnpm 9.15.4, Node >= 20 (VM runs Node 24), vitest 5. vitest 5 has no `vitest.workspace.ts`; hackkit uses `test.projects` in the root `vitest.config.ts` instead.

## Ground rules and repo layout

- Use-and-throw building blocks: keep each piece the smallest thing that works. Extension points are interfaces with one default each, nothing more.
- Project-agnostic: hackkit and agentmemory contain no code, cases, configs or names from any specific project. Project adapters and cases live in each project's own repo.
- TypeScript, Node 20 or later, ESM only (`"type": "module"`), strict TS. Run TS directly with `tsx`; build to `dist/` with `tsc` for the bins and package exports.
- Deps: `openai`, `dotenv`, `yaml`, `zod`, `ulid`, `better-sqlite3`, `cli-table3`. Dev: `typescript`, `tsx`, `vitest`, `@types/node`, `@types/better-sqlite3`. Nothing else without a reason.
- Secrets only in `.env` (git-ignored): `NEBIUS_API_KEY`, `META_API_KEY`, `QLOO_API_KEY`. Never in code, prompts, logs, test fixtures or results files.
- `.env.example` with empty values is committed. Tests never need real keys or a real agy; live tests run only with `LIVE=1 pnpm test` (`describe.runIf(process.env.LIVE)`).
- All repos are private on GitHub `tirthpatel002` during the build. A repo is made public with an MIT licence (shown in its About box) only when it is submitted or first needed in public.
- Projects depend on hackkit packages with `link:` or `file:` during the build and copy them under `vendor/` before their own repo goes public. `agentmemory` is its own private repo.
- All times stored as ISO 8601 with offset; IDs are ULIDs with a prefix (`c_`, `run_`, `ev_`, `les_`). Public TS names are camelCase; file formats (log lines, results JSON, YAML cases, DB columns) stay snake_case.

```
hackkit/                          # private repo on tirthpatel002 (pnpm workspace: connector + harness)
  package.json                    # "type": "module", "packageManager": "pnpm@<pin>", engines.node ">=20"
  pnpm-workspace.yaml             # packages: ["packages/*"]
  tsconfig.base.json
  vitest.workspace.ts
  .env.example  .gitignore        # .env, logs/, results/, *.db ignored
  packages/
    connector/                    # @hackkit/connector
      package.json  tsconfig.json
      src/ ...  test/ ...
    harness/                      # @hackkit/harness   (bin: harness)
      package.json  tsconfig.json
      src/ ...  test/ ...  examples/echo/ ...

agentmemory/                      # separate private repo on tirthpatel002; npm package later
  package.json  tsconfig.json  src/ ...  test/ ...  examples/ ...  README.md  LICENSE (MIT, added before going public)

# NOT here: any project adapter, case file, rubric, model config or eval runner.
# Those live in each project's own repo and import these packages.
```

```
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "skipLibCheck": true
  }
}
```

## 1. Model connector (@hackkit/connector)

One function for chat and one for embeddings across Nebius Token Factory, Meta Model API and the local agy CLI, plus a separate Qloo client. Handles keys, retries, fallback, cost and logging so calling code never does.

### Providers (API details checked on public docs, 27 Oct 2026)

| Provider | Base URL / binary | Auth | Models used |
|---|---|---|---|
| Nebius Token Factory | `https://api.tokenfactory.nebius.com/v1/` | `Authorization: Bearer` | `nvidia/nemotron-3-super-120b-a12b`, `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, embed `Qwen/Qwen3-Embedding-8B` |
| Meta Model API | `https://api.meta.ai/v1` | `Authorization: Bearer` (keys start `LLM_`) | `muse-spark-1.3`, `muse-spark-1.2`, `muse-wonder-1.0` |
| agy-cli (local) | `~/.local/bin/agy`, optional wrapper | agy's own login on the VM | default `gemini-3.8-flash-high`, any `agy-cli:<model>` |
| Qloo (hackathon) | `https://hackathon.api.qloo.com` | `X-Api-Key` header | `GET /search`, `GET /v2/insights`, `GET /v2/tags` |

- Nebius and Meta are both OpenAI-compatible, so one `openaiCompat.ts` provider using the `openai` npm package with `baseURL` and `maxRetries: 0` serves both; `router.ts` does the retries. Nebius documents this SDK route. Meta's docs show the `openai` npm client with `baseURL: "https://api.meta.ai/v1"` for listing models; chat, tools and json mode through it on Meta: to confirm in C2.
- Nebius Nemotron docs also show a regional URL `https://api.tokenfactory.us-central1.nebius.com/v1/`. Which host serves which model: to confirm with the smoke test.
- Meta: Muse Spark always reasons, so `reasoning_effort: "none"` returns 400; `stop`, `n > 1` and `logit_bias` also return 400. The Meta provider strips them.
- Meta lists no embedding model, so `embed()` always uses Nebius `Qwen/Qwen3-Embedding-8B` (4096 dims by default, optional `dimensions`). A Meta-only setup therefore still needs a Nebius key for embeddings: acceptable or not, to confirm.
- "Muse Code" is Meta's coding product (Muse Code app/plans), not an API model ID. For code work use `muse-wonder-1.0` (or `muse-spark-1.3`): to confirm with Tirth.
- Qloo hackathon keys return 401 on `api.qloo.com` and staging. Every insights call needs `filter.type` (`urn:entity:movie`, `place`, `destination`, ...); a 200 with no entities usually means a wrong parameter. QlooClient uses Node's built-in `fetch` with `AbortSignal.timeout()`.

### File layout

```
packages/connector/
  src/
    index.ts          # exports chat, embed, QlooClient, types, errors
    types.ts          # Reply, ToolCall, Message, Tool, ChatOptions, EmbedOptions
    errors.ts         # Error subclasses
    config.ts         # dotenv + config/models.yaml (or models.config.ts), alias resolution
    prices.ts         # loads prices.yaml, costUsd()
    router.ts         # retry + fallback loop, used by chat() and embed()
    log.ts            # appends one JSON line per attempt to logs/calls.jsonl
    providers/
      base.ts         # Provider interface
      openaiCompat.ts # openai npm client with baseURL; shared by Nebius + Meta
      nebius.ts       # base URL, key name, quirks
      meta.ts         # base URL, key name, quirks (no stop, no n > 1)
      agyCli.ts       # spawns the local agy CLI, returns stdout
    qloo.ts           # QlooClient (search, insights, tags) on native fetch, not chat
    smoke.ts          # pnpm smoke : calls every configured provider
  prices.yaml         # price table with as_of date
  test/
    fixtures/fake-agy.mjs   # stand-in agy binary for tests
    *.test.ts               # vitest
```

### Public API

```
export type Role = "system" | "developer" | "user" | "assistant" | "tool";
export interface Message {                 // OpenAI chat shape
  role: Role;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: unknown[];
}
export interface Tool {                    // OpenAI tool schema
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;      // parsed from the JSON string the API returns
}

export interface Reply {
  text: string;                            // "" when the model only called tools
  toolCalls: ToolCall[];                   // always [] for agy-cli
  tokensIn: number | null;                 // usage.prompt_tokens; null for agy-cli
  tokensOut: number | null;                // usage.completion_tokens (includes reasoning); null for agy-cli
  costUsd: number | null;                  // null for agy-cli
  latencyMs: number;                       // wall time of the successful attempt
  model: string;                           // "provider:modelId" that actually answered
  tokensCached: number | null;             // usage.prompt_tokens_details.cached_tokens or 0; null for agy-cli
  fallbackUsed: boolean;
  attempts: number;
  callId: string;                          // same id as the log line
  json<T = unknown>(): T;                  // JSON.parse(text); throws BadJSONError
  raw: unknown;
}

export interface ChatOptions {
  tools?: Tool[];
  json?: boolean;                          // response_format {"type":"json_object"} + parse
  temperature?: number;
  maxTokens?: number;                      // sent as max_completion_tokens
  timeoutMs?: number;                      // overrides config
  project?: string;                        // defaults to CONNECTOR_PROJECT or config
  tag?: string;                            // free label for logs, e.g. "distiller"
  signal?: AbortSignal;
}

export function chat(model: string, messages: Message[], opts?: ChatOptions): Promise<Reply>;
// model: alias ("main"), "provider:modelId", "agy-cli" or "agy-cli:<agyModel>"

export interface EmbedOptions { model?: string; dimensions?: number; signal?: AbortSignal }
export function embed(texts: string[], opts?: EmbedOptions): Promise<Float32Array[]>;
// same order as texts; batches of 64; default model alias "embed"

export interface QlooEntity { entity_id: string; name: string; types?: string[];
  properties?: Record<string, unknown>; tags?: { id?: string; name: string }[] }

export class QlooClient {
  constructor(opts?: { apiKey?: string; baseUrl?: string; timeoutMs?: number });
  search(query: string, types: string[], take?: number): Promise<QlooEntity[]>;   // take default 6
  insights(filterType: string, opts?: { entities?: string[]; tags?: string[];
    locationQuery?: string; take?: number; extra?: Record<string, string> }): Promise<QlooEntity[]>;
  tags(query: string, take?: number): Promise<{ id: string; name: string; type?: string }[]>;
}
```

- `tools` and tool calls use the OpenAI shapes on Nebius and Meta; `ToolCall.arguments` is parsed JSON (bad JSON throws `BadJSONError` with `rawText`).
- `json: true` sends `response_format: {"type": "json_object"}`, then `JSON.parse`. On failure: one repair attempt with the parse error appended, then `BadJSONError`. Nebius support for `json_object` per model: to confirm.
- Safe to call concurrently; one client per provider, created lazily. No streaming in v1. Every call accepts an `AbortSignal`.
- QlooClient: `search` sends `query`, `types` (comma-joined URNs) and `take`; `insights` maps to `filter.type`, `signal.interests.entities`, `filter.tags`, `filter.location.query`, `take`. Exact `search` param name (`types` vs `type`) and `take` max (50 reported): to confirm. Returns `results.entities` (insights) or `results` (search). 404 on search means no results and returns `[]`.

### agy-cli provider

```
// providers/agyCli.ts  -- whole provider, kept small
import { spawn } from "node:child_process";
import { homedir } from "node:os";

export function flatten(messages: Message[]): string {
  // "SYSTEM:\n...\n\nUSER:\n...\n\nASSISTANT:\n..."  (tool messages as "TOOL RESULT <id>:")
  return messages.map((m) => label(m) + ":\n" + (m.content ?? "")).join("\n\n");
}

export async function agyChat(model: string, messages: Message[], opts: ChatOptions, cfg: AgyConfig) {
  if (opts.tools?.length) throw new BadRequestError("tools are not supported on agy-cli");
  let prompt = flatten(messages);
  if (opts.json) prompt += "\n\nReply with one JSON value only, no other text.";
  const agyModel = model.split(":")[1] ?? cfg.defaultModel;          // default gemini-3.8-flash-high
  const bin = cfg.bin.replace(/^~/, homedir());                       // default ~/.local/bin/agy
  const args = ["--dangerously-skip-permissions", "-p", prompt, "--model", agyModel];
  const [cmd, ...pre] = cfg.wrapper.length ? [...cfg.wrapper, bin] : [bin];   // e.g. ["agy-as", "acct2"]
  const child = spawn(cmd, [...pre, ...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  // collect stdout/stderr; on cfg.timeoutMs or opts.signal: child.kill("SIGKILL") -> ProviderError("timeout")
  // exit code != 0 -> ProviderError(message, { stderr, exitCode }); spawn ENOENT -> ConfigError("agy not found at <cmd>")
  // exit 0 -> Reply { text: stdout.trim(), toolCalls: [], tokensIn: null, tokensOut: null,
  //                   tokensCached: null, costUsd: null, model: "agy-cli:" + agyModel, latencyMs }
}
```

- `chat("agy-cli", messages)` uses `default_model`; `chat("agy-cli:<agyModel>", messages)` passes that model. An alias can point at either.
- Messages are flattened into one prompt (role label, colon, newline, content; blank line between messages). Spawned with an args array and `shell: false`, so the prompt reaches agy as one argument, unquoted and unexpanded.
- Command: `agy --dangerously-skip-permissions -p <prompt> --model <agyModel>`. With a wrapper such as `[agy-as, acct2]` the command becomes `agy-as acct2 <bin> --dangerously-skip-permissions -p ...`.
- stdout (trimmed) becomes `Reply.text`. Tokens and cost are `null`; latency is measured and logged. `toolCalls` is always empty; passing `tools` throws `BadRequestError`.
- Non-zero exit or timeout throws `ProviderError` with `exitCode` and the last 4 KB of stderr. Binary not found throws `ConfigError`. Default `max_retries: 0` for this provider; the fallback chain still applies.
- `json: true` adds one line asking for JSON only. `reply.json()` is best effort: parse the whole text; else strip a code fence; else parse from the first `{` or `[` to the last `}` or `]`; else `BadJSONError`. No repair call.
- No secret guard or prompt filtering in this provider: it runs agy with the prompt and returns stdout.

### Config

```
# .env  (git-ignored; loaded with dotenv at import of config.ts; never printed or logged)
NEBIUS_API_KEY=
META_API_KEY=          # Meta docs call it MODEL_API_KEY; we read META_API_KEY and pass it explicitly
QLOO_API_KEY=
CONNECTOR_PROJECT=my-app         # optional; label written into log lines
CONNECTOR_CONFIG=config/models.yaml   # optional; or config/models.config.ts
CONNECTOR_LOG=logs/calls.jsonl   # optional
```

```
# <your project repo>/config/models.yaml
project: my-app
defaults:
  timeout_ms: 60000      # read timeout per attempt
  max_retries: 3         # retries after the first try, per model
providers:
  nebius:
    base_url: https://api.tokenfactory.nebius.com/v1/
    key_env: NEBIUS_API_KEY
  meta:
    base_url: https://api.meta.ai/v1
    key_env: META_API_KEY
    timeout_ms: 120000   # Muse Spark always reasons; longer replies
  agy-cli:
    bin: ~/.local/bin/agy
    wrapper: []          # e.g. [agy-as, acct2] to run under another account
    default_model: gemini-3.8-flash-high
    timeout_ms: 300000
    max_retries: 0       # a failed CLI run goes straight to fallback
aliases:
  main:  nebius:nvidia/nemotron-3-super-120b-a12b
  cheap: nebius:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B
  judge: nebius:nvidia/nemotron-3-super-120b-a12b
  local: agy-cli:gemini-3.8-flash-high
  embed: nebius:Qwen/Qwen3-Embedding-8B
fallback:                # tried in order after the named model gives up
  main:  [nebius:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B, meta:muse-spark-1.3]
  cheap: [nebius:nvidia/nemotron-3-super-120b-a12b]
  judge: [meta:muse-spark-1.3]
  local: [nebius:nvidia/nemotron-3-super-120b-a12b]
  embed: []              # no cross-provider fallback: vectors would not match
```

```
// <your project repo>/config/models.config.ts  (same shape, typed; use instead of YAML if preferred)
import { defineConfig } from "@hackkit/connector";
export default defineConfig({
  project: "my-meta-app",
  aliases: {
    main: "meta:muse-spark-1.3",
    code: "meta:muse-wonder-1.0",             // "Muse Code" is Meta's coding product, not an API model ID (to confirm with Tirth)
    embed: "nebius:Qwen/Qwen3-Embedding-8B",  // Meta lists no embedding model (to confirm)
  },
  fallback: {
    main: ["meta:muse-spark-1.2", "nebius:nvidia/nemotron-3-super-120b-a12b"],
    code: ["meta:muse-spark-1.3"],
  },
});
```

Lookup order: `CONNECTOR_CONFIG`, then `./config/models.config.ts`, then `./config/models.yaml`. Both are checked with one zod schema and mapped to camelCase. A model string with a colon is used as is, `agy-cli` alone means its default model, anything else must be an alias. Unknown alias or missing key throws `ConfigError` naming the variable, never its value.

### Errors, retries, timeouts, fallback

```
export class ConnectorError extends Error {
  constructor(message: string, readonly opts: { model?: string; status?: number; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
  }
}
export class ConfigError extends ConnectorError {}      // missing key, unknown alias, bad yaml, agy binary not found. Never retried.
export class AuthError extends ConnectorError {}        // 401/403. Not retried, straight to fallback.
export class BadRequestError extends ConnectorError {}  // 400/404/413/422, or tools sent to agy-cli. Not retried, no fallback.
export class RateLimitError extends ConnectorError {    // 429. Retried.
  retryAfterMs?: number;
}
export class ProviderTimeout extends ConnectorError {}  // timeout, connection reset. Retried.
export class ProviderError extends ConnectorError {     // 5xx; agy-cli non-zero exit or timeout
  stderr?: string;                                      // agy-cli: last 4 KB of stderr
  exitCode?: number | null;
}
export class BadJSONError extends ConnectorError {      // json:true and text did not parse
  rawText = "";
}
export class AllModelsFailed extends ConnectorError {   // every model in the chain failed
  attempts: { model: string; errorType: string; status?: number; message: string }[] = [];
}
export class QlooError extends ConnectorError {}        // Qloo errors, same status mapping
```

```
// providers/openaiCompat.ts
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: cfg.baseUrl,          // Nebius or Meta
  apiKey: process.env[cfg.keyEnv],
  maxRetries: 0,                 // router.ts owns retries
  timeout: cfg.timeoutMs,
  fetch: cfg.fetch,              // injected fake fetch in tests
});
// SDK error -> ours
// OpenAI.APIConnectionTimeoutError, APIConnectionError -> ProviderTimeout
// OpenAI.RateLimitError (429)                          -> RateLimitError (+ Retry-After from err.headers)
// OpenAI.AuthenticationError (401), PermissionDeniedError (403) -> AuthError
// OpenAI.BadRequestError (400), NotFoundError (404), UnprocessableEntityError (422), 413 -> BadRequestError
// OpenAI.InternalServerError, other >= 500             -> ProviderError
```

| Case | Retry same model | Then fallback |
|---|---|---|
| 429 rate limit | Yes, 3 times | Yes |
| Timeout / connection error | Yes, 3 times | Yes |
| 5xx | Yes, 3 times | Yes |
| agy-cli non-zero exit or timeout | No (max_retries 0) | Yes |
| 401 / 403 (bad or killed key) | No | Yes, skip every model on that provider |
| 400 / 404 / 413 / 422, tools on agy-cli | No | No, throw BadRequestError |
| Missing key in .env, agy binary missing | No | Yes, logged as ConfigError, skip that provider |

- Backoff before retry n (n = 0, 1, 2): `500 * 2^n` ms plus jitter of 0 to 500 ms, so about 0.5 s, 1 s, 2 s. If the response has `Retry-After`, wait max(that, backoff), capped at 20 s.
- Timeouts per attempt: 60 s (Meta 120 s) via the SDK `timeout`, agy-cli 300 s (child killed), Qloo 20 s. Whole `chat()` call capped at 600 s by an outer `AbortSignal.timeout`; past that throw `AllModelsFailed`.
- Fallback chain = requested model, then `fallback[alias]`. Each model gets its own 1 + `max_retries` attempts. If all fail: `AllModelsFailed` with every attempt listed.
- A fallback model may not support tools or `json`: the call still goes, and `reply.fallbackUsed` lets the caller decide.
- QlooClient retries 429/5xx/timeouts with the same backoff, no fallback.

### Cost and logging

```
# packages/connector/prices.yaml   USD per 1M tokens, read from provider pages on 2026-10-27
as_of: 2026-10-27
nebius:nvidia/nemotron-3-super-120b-a12b:     {in: 0.30, cached: 0.06,  out: 0.90}
nebius:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B: {in: 0.06, cached: 0.012, out: 0.24}
nebius:nvidia/Nemotron-3-Ultra-550b-a55b:     {in: 1.00, cached: 0.12,  out: 3.00}
nebius:nvidia/Nemotron-3.5-Super-VL:          {in: 0.30, cached: 0.06,  out: 0.90}
nebius:Qwen/Qwen3-Embedding-8B:               {in: 0.01, cached: 0.01,  out: 0.00}
meta:muse-spark-1.3:                          {in: 1.25, cached: 0.15,  out: 4.25}
meta:muse-spark-1.2:                          {in: 1.25, cached: 0.15,  out: 4.25}
meta:muse-wonder-1.0:                         {in: 4.00, cached: 0.20,  out: 20.00}
# agy-cli: no entry; cost is null
```

`costUsd = ((tokensIn − cached) × in + cached × cachedPrice + tokensOut × out) / (1,000,000)`

- Prices copied from the Nebius model catalog and Meta pricing page on 27 Oct 2026; Nebius `/api/public/models_info` is the machine-readable source. A model missing from the table gives `costUsd = 0` and a `price_missing` warning in the log; agy-cli always gives `null`.
- Meta `tokensOut` already counts reasoning tokens (`completion_tokens`), so Muse cost includes thinking.

One JSON line per attempt (not per call) appended to `logs/calls.jsonl` with one `fs.appendFileSync` per line (one process per log file). No message content, only a SHA-256 of the prompt (`node:crypto`). The line format stays snake_case.

```
{"ts": "2026-10-27T20:15:03.412+05:30", "call_id": "c_01J...", "project": "my-app",
 "tag": "chat", "kind": "chat", "requested": "main", "model": "nebius:nvidia/nemotron-3-super-120b-a12b",
 "attempt": 1, "fallback_index": 0, "status": "ok", "error_type": null, "http_status": 200,
 "tokens_in": 812, "tokens_cached": 0, "tokens_out": 164, "cost_usd": 0.000391,
 "latency_ms": 2140, "n_messages": 4, "n_tools": 2, "json_mode": false,
 "prompt_sha": "9f2c...", "error": null}
{"ts": "...", "call_id": "c_01K...", "model": "agy-cli:gemini-3.8-flash-high", "status": "ok",
 "http_status": null, "exit_code": 0, "tokens_in": null, "tokens_out": null, "cost_usd": null,
 "latency_ms": 6120, "...": "..."}
```

`status` is `ok`, `retry`, `fallback` or `failed`; `error_type` is the Error subclass name. agy-cli lines carry `exit_code` and null tokens and cost. Qloo calls log with `kind: qloo`, endpoint and result count.

### Smoke script (the success target)

```
$ pnpm --filter @hackkit/connector smoke        # = tsx src/smoke.ts
nebius  chat   ok   nvidia/nemotron-3-super-120b-a12b  1.9s  $0.0003
nebius  embed  ok   Qwen/Qwen3-Embedding-8B dim=4096    0.4s  $0.0000
meta    chat   ok   muse-spark-1.3                      4.2s  $0.0021
agy-cli chat   ok   gemini-3.8-flash-high               6.1s  cost n/a
qloo    search ok   "Dune" -> 6 movies                  0.6s
$ NEBIUS_API_KEY=bad pnpm --filter @hackkit/connector smoke --only nebius-chat
nebius  chat   AuthError -> fallback meta:muse-spark-1.3 ok  (fallbackUsed=true)
```

### Tests (vitest)

- Unit (fake `fetch` injected into the OpenAI client): text reply maps to Reply; tool-call reply parses arguments; usage maps to tokens and cost.
- Unit: 429 then 200 gives attempts=2 and honours `Retry-After` (`vi.useFakeTimers()`).
- Unit: 3 timeouts then fallback model answers, `fallbackUsed` true, 5 log lines.
- Unit: 401 skips retries and every model on that provider.
- Unit: 400 throws BadRequestError with no fallback.
- Unit: all fail throws AllModelsFailed listing every attempt; `instanceof` works for each Error subclass.
- Unit: `json: true` with bad JSON does one repair, then BadJSONError.
- Unit: cost formula per price row; missing price gives 0 and a warning.
- Unit: log line has every schema field and no key or message text (read the file, search for the fake key).
- Unit: Meta provider strips `stop` and `n`; alias resolution; YAML and TS config give the same result; missing key throws ConfigError naming the variable.
- Unit (agy-cli, `test/fixtures/fake-agy.mjs` set as `bin`; it prints its argv as JSON, and env vars make it exit 2 with stderr or sleep): exact args array; default and explicit model; wrapper prepended; a prompt with quotes, `;` and `$` arrives as one unchanged argument; non-zero exit gives ProviderError with stderr; timeout gives ProviderError and the child is killed; missing bin gives ConfigError; tools give BadRequestError; json best-effort parse on fenced and prose-wrapped output; log line has latency and null tokens and cost.
- Unit: QlooClient builds the right query string; 404 search returns `[]`.
- End-to-end (`LIVE=1`): the smoke script passes on all providers, then again with `NEBIUS_API_KEY=bad` and fallback reaches Meta.

Acceptance: `pnpm -r typecheck` and `pnpm test` clean; smoke passes with real keys and a logged-in agy; killed-key run falls back; `logs/calls.jsonl` has one valid line per attempt; a repo-wide search finds no key values.

## 2. Test harness (@hackkit/harness)

Runs YAML test cases against an agent through an adapter, grades them with registered checks, and writes a results file so two runs can be compared before and after a change. Two case kinds: answer cases (one input, one output) and trace cases (the harness runs the agent and checks its steps and tool calls). The package ships only a generic `examples/echo` adapter and a few sample cases; project adapters and cases live in each project's own repo.

### File layout and project config

```
packages/harness/
  package.json       # "bin": {"harness": "dist/cli.js"}
  src/
    index.ts         # run(), compare(), registerCheck(), types
    cli.ts           # run | compare | list | list-checks
    cases.ts         # YAML (yaml npm) + zod validation -> Case[]
    registry.ts      # check registry (Map<string, CheckPlugin>)
    checks/
      builtin.ts     # exact, contains, judge, custom
      trace.ts       # toolCalled, toolNotCalled, order, maxSteps, finalOutput
    judge.ts         # rubric prompt + parse, via chat("judge", ..., {json: true})
    pool.ts          # worker pool: N in flight, per-case timeout, results kept in case order
    runner.ts        # runs answer cases (RunCase) and trace cases (RunAgent)
    report.ts        # terminal table (cli-table3), results JSON writer
    compare.ts
  examples/echo/     # the only "project" in this repo: generic, used by tests and docs
    harness.yaml
    rubrics.yaml
    cases/basic.yaml
    cases/trace.yaml
    src/adapter.ts   # runCase: canned answers + optional fake delay (ECHO_DELAY_MS)
    src/agent.ts     # runAgent: toy loop over fake "search" and "calculator" tools
    src/checks.ts    # one custom fn + one registered check type
  test/*.test.ts
```

```
# examples/echo/harness.yaml   (a project's own harness.yaml has the same shape, in its own repo)
adapter: src/adapter.ts:runCase             # answer cases
agent_adapter: src/agent.ts:runAgent        # trace cases (optional)
check_plugins: [src/checks.ts]              # imported before cases load; they call registerCheck
cases: cases/
concurrency: 8                              # --concurrency overrides
case_timeout_s: 30
judge_model: judge                          # connector alias
rubrics: rubrics.yaml
```

Adapter, agent adapter and custom check paths are `file.ts:exportName`, relative to the folder holding `harness.yaml`, loaded with dynamic `import()`. Files in `check_plugins` are imported once before cases load. The CLI registers `tsx` so `.ts` files load without a build (via `tsx/esm/api`: to confirm in H1).

### Public API and types

```
// ---- cases ----
export type CaseKind = "answer" | "trace";        // "answer" is the default

export interface CheckSpec {                       // one entry under check: in YAML
  type: string;                                    // any registered type
  field?: string;                                  // default "text"; dotted path
  negate?: boolean;                                // pass when the check fails
  [option: string]: unknown;                       // type-specific options (value, rubric, tool, ...)
}

export interface Case {
  id: string;
  kind?: CaseKind;
  input: Record<string, unknown>;
  expect?: unknown;
  check: CheckSpec[];                              // all must pass
  tags?: string[];
  timeout_s?: number;                              // default 30
  skip?: boolean;
}

// ---- adapters ----
export interface CaseOutput {                      // answer cases
  text: string;
  data?: Record<string, unknown>;
  callIds?: string[];                              // Reply.callId values, for cost
}
export type RunCase = (input: Record<string, unknown>,
  ctx: { model?: string; signal: AbortSignal }) => Promise<CaseOutput>;

export interface TraceStep {                       // trace cases
  seq: number;
  type: "step" | "tool_call" | "tool_result" | "error" | (string & {});
  tool?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}
export interface AgentTrace { steps: TraceStep[]; final: CaseOutput }
export type RunAgent = (input: Record<string, unknown>,
  ctx: { model?: string; signal: AbortSignal; maxSteps?: number }) => Promise<AgentTrace>;

// ---- checks ----
export interface CheckResult { type: string; passed: boolean; score: number | null; reason: string; costUsd?: number }
export interface CheckContext { case: Case; output: CaseOutput; trace?: AgentTrace;
  chat: typeof import("@hackkit/connector").chat; signal: AbortSignal }

export interface CheckPlugin<O = Record<string, unknown>> {
  type: string;                                    // e.g. "regex", "jsonShape"
  options?: import("zod").ZodType<O>;              // validates the YAML options at load time
  needsTrace?: boolean;                            // true: only valid in trace cases
  run(opts: O, ctx: CheckContext): Promise<CheckResult> | CheckResult;
}
export function registerCheck(plugin: CheckPlugin<any>): void;   // throws if type already taken
export function listChecks(): string[];

// ---- results ----
export interface CaseResult {
  id: string; kind: CaseKind; passed: boolean; checks: CheckResult[];
  output: string;                                  // first 2000 chars of final text
  steps?: number;                                  // trace cases only
  costUsd: number; judgeCostUsd: number; timeMs: number;   // null provider costs count as 0
  error: string | null;                            // adapter error or "timeout"
}

export interface RunOptions { casesFile?: string; model?: string; concurrency?: number; tags?: string[] }
export function run(project: string, opts?: RunOptions): Promise<ResultsFile>;
export function compare(aPath: string, bPath: string): Promise<CompareResult>;
```

### Check registry

- One registry (`Map<string, CheckPlugin>`). Built-ins `exact`, `contains`, `judge`, `custom` and the five trace checks are registered at import; any repo adds types with `registerCheck()` from a `check_plugins` file.
- At load time every `check[]` entry is looked up by `type` and its options parsed with the plugin's zod schema. Unknown type, bad options, duplicate type, or a trace-only check in an answer case stop the run with exit code 2 before any call.
- `field` and `negate` are handled by the runner for every plugin, so plugins only see the value they check.
- `custom` stays for one-off functions (`fn: src/checks.ts:exportName`); register a type when the same check is used in many cases.

```
// examples/echo/src/checks.ts  -- listed under check_plugins in harness.yaml
import { z } from "zod";
import { registerCheck } from "@hackkit/harness";

export const isUpperCase = async (c, out) =>
  ({ type: "custom", passed: out.text === out.text.toUpperCase(), score: null, reason: "" });

registerCheck({
  type: "maxLength",
  options: z.object({ chars: z.number().int().positive() }),
  run: (o, ctx) => {
    const n = ctx.output.text.length;
    return { type: "maxLength", passed: n <= o.chars, score: null, reason: n + " chars" };
  },
});
```

### CLI

```
# in any repo that depends on @hackkit/harness:  "scripts": {"harness": "harness"}
pnpm harness run examples/echo                      # all cases in examples/echo/cases/
pnpm harness run examples/echo --cases cases/basic.yaml
pnpm harness run examples/echo --model cheap --concurrency 8 --tag smoke
pnpm harness compare results/A.json results/B.json
pnpm harness list examples/echo                     # ids, kind, tags; no calls
pnpm harness list-checks examples/echo              # registered check types
# without the bin: npx tsx node_modules/@hackkit/harness/src/cli.ts run <dir>
# <project> = folder holding harness.yaml: a path, or a name looked up as ./<name>, then ../<name>
# exit code: 0 all pass, 1 some fail, 2 config error
```

### Case schema

| Field | Type | Rule |
|---|---|---|
| `id` | string | Required, unique across all loaded files, `[a-z0-9-]+` |
| `kind` | enum | `answer` (default) or `trace`; trace needs `agent_adapter` |
| `input` | mapping | Required; passed unchanged to the adapter |
| `expect` | any | Reference answer for checks and the judge |
| `check` | list | Required, at least 1; a single mapping is allowed and wrapped |
| `check[].type` | string | Any registered type |
| `check[].field` | string | Default `text`; dotted path like `data.sentences` |
| `check[].negate` | bool | Default false; passes when the check fails (for must-not-appear) |
| `check[].fn` | string | custom only: `src/checks.ts:exportName` |
| `tags`, `timeout_s`, `skip` | optional | Filter with `--tag`; default timeout 30 s |

```
# examples/echo/cases/basic.yaml   (answer cases)
- id: echo-001-shout
  input: {text: "hello"}
  expect: "HELLO"
  check:
    - {type: exact, value: "HELLO"}
    - {type: custom, fn: "src/checks.ts:isUpperCase"}

- id: echo-002-capital
  tags: [smoke]
  input: {question: "What is the capital of France?"}
  expect: "Paris"
  check:
    - {type: contains, value: "Paris"}
    - {type: contains, value: ["London", "Berlin"], all_of: false, negate: true}
    - {type: maxLength, chars: 200}

- id: echo-003-explain
  input: {question: "Why is the sky blue? One sentence."}
  expect: "Sunlight scatters off air molecules and blue light scatters most."
  check:
    - {type: judge, rubric: matches-expected, pass_score: 4}
    - {type: exact, field: "data.sentences", value: "1"}
```

Built-in rules: `exact` compares after trimming whitespace (case-insensitive unless `case_sensitive`). `contains` needs all strings (or any, with `all_of: false`). `custom` imports the export once and calls it with the case and output.

### Trace cases (multi-step agent runs)

```
# examples/echo/cases/trace.yaml   (trace cases: harness runs the agent, checks the steps)
- id: agent-001-search-then-compute
  kind: trace
  input: {task: "Find the population of Pune and divide it by 1000."}
  check:
    - {type: toolCalled, tool: "search", min: 1}
    - {type: toolNotCalled, tool: "delete_file"}
    - {type: order, tools: ["search", "calculator"]}   # subsequence, gaps allowed
    - {type: maxSteps, value: 8}
    - {type: finalOutput, check: {type: contains, value: "thousand"}}
```

| Check | Options | Passes when |
|---|---|---|
| `toolCalled` | `tool`, `min` (1), `max`, `args` (subset match) | Count of `tool_call` steps with that tool is within min..max |
| `toolNotCalled` | `tool` | No `tool_call` step with that tool |
| `order` | `tools: string[]`, `strict` (false) | Tools appear in that order; `strict` means adjacent |
| `maxSteps` | `value` | Total steps at or below value |
| `finalOutput` | `check`: any answer check | Runs the nested check on `trace.final` |

- The runner calls `runAgent(input, { model, signal, maxSteps })`; the adapter runs the agent loop and returns every step plus the final output. `maxSteps` is passed so the adapter can stop a runaway loop.
- Step `type` is open: the built-in five plus any custom string, same as agentmemory events, so an adapter can pass memory events straight through.
- Tool names are matched exactly. `args` in `toolCalled` is a subset match on the call input.

### Judge rubric and prompt

```
# examples/echo/rubrics.yaml
matches-expected:
  scale: "1-5"
  criteria:
    - "Answer matches the expected answer in meaning."
    - "No invented facts."
    - "Follows any length or format limit in the input."
  score_guide:
    5: "fully correct, nothing extra wrong"
    4: "correct, minor wording issue"
    3: "partly correct"
    2: "mostly wrong"
    1: "wrong or harmful"
```

```
system: You grade one answer against a rubric. Reply with JSON only.
user:
  RUBRIC: <criteria + score_guide>
  INPUT: <case.input as JSON>
  EXPECTED: <case.expect>
  ANSWER: <CaseOutput.text>
  Return {"score": 1-5, "reason": "<one sentence>", "failed_criteria": [<index>, ...]}
# temperature 0; parse with reply.json() + zod; invalid JSON -> one retry -> check fails with reason "judge_unparseable"
```

Passes when `score >= pass_score` (default 4). Judge calls go through the connector with `tag: "judge"`, so their cost is counted separately as `judge_cost_usd`. Tests use a fake judge LLM.

### Parallel runs

- `--concurrency N` (default from `harness.yaml`, else 8): a simple worker pool of N async workers pulling the next case index from a shared counter.
- Deterministic ordering: each result is written into `results[index]` by its load order (file name, then position in file), so the table and results JSON are in the same order on every run whatever finishes first.
- Per-case timeout (`timeout_s`, default 30 s): an `AbortController` per case, aborted on timeout; the case is marked errored with `error: "timeout"` and the worker moves on.
- Adapter rejections become `error` on the case (failed, not a crash). Judge calls share the same pool slot as their case.
- Cost per case = sum of `cost_usd` for its `callIds` read from `logs/calls.jsonl` (null counts as 0), plus judge cost.
- `--model` is passed to the adapter as `ctx.model`; the adapter uses it in its `chat()` calls.
- Terminal table: id, kind, pass/fail, checks, cost, time; failures listed last with their reason; summary line with pass rate, cost and wall time. Results written to `results/<YYYY-MM-DDTHHMM>_<model>.json`.

### Results JSON

```
{
  "schema": 1,
  "project": "echo",
  "run_id": "2026-10-28T1130_main",
  "started_at": "2026-10-28T11:30:02+05:30",
  "git_sha": "a1b2c3d",
  "model": "main", "judge_model": "judge",
  "cases_file": "cases/",
  "concurrency": 8,
  "summary": {"total": 20, "passed": 17, "failed": 2, "errored": 1, "skipped": 0,
              "pass_rate": 0.85, "cost_usd": 0.0412, "judge_cost_usd": 0.0108,
              "wall_time_s": 71.4, "p50_case_ms": 2900, "p95_case_ms": 8800},
  "cases": [
    {"id": "echo-002-capital", "kind": "answer", "passed": true, "cost_usd": 0.0009,
     "judge_cost_usd": 0.0, "time_ms": 2410, "error": null,
     "checks": [{"type": "contains", "passed": true, "score": null, "reason": ""}],
     "output": "Paris."},
    {"id": "agent-001-search-then-compute", "kind": "trace", "steps": 6, "passed": true, "...": "..."}
  ]
}
```

Schema 1 with three optional fields: `concurrency` at the top, and `kind` and `steps` per case. Files without them still load in compare.

### Compare output

```
$ pnpm harness compare results/A.json results/B.json
                 A (main)    B (main+change)   change
pass rate        70.0%       85.0%             +15.0 pts
cost             $0.0390     $0.0412           +5.6%
wall time        68.2s       71.4s             +4.7%
fixed   (fail->pass): echo-003-explain, agent-001-search-then-compute
broke   (pass->fail): none
still failing:        echo-014-long-input
only in A / only in B: none
# also written as results/compare_A_vs_B.json
```

Cases are matched by id. Compare warns when the two files used different case sets or judge models.

### Tests (vitest)

- Unit: YAML loader accepts the echo answer and trace examples; rejects duplicate id, unknown check type, bad plugin options, trace check in an answer case, missing `check`.
- Unit: registry: built-ins present; `registerCheck` adds a type that cases can use; registering a taken type throws.
- Unit: exact (trim, case), contains (all and any), negate, dotted `field` paths.
- Unit: custom check loads a `.ts` export and calls it; bad path or missing export gives a load error.
- Unit: judge with a fake LLM returning score 5, 3 and bad JSON (one retry, then fail with `judge_unparseable`).
- Unit: each trace check on a fixed fake trace: toolCalled (min, max, args), toolNotCalled, order (gaps and strict), maxSteps, finalOutput with a nested contains.
- Unit: pool with concurrency 3 on 10 fake cases of random delay: never more than 3 in flight; results come back in load order on 5 repeated runs.
- Unit: timeout marks only that case errored and aborts its signal; adapter rejection is captured.
- Unit: cost sums from a fixture `calls.jsonl`, including null costs.
- Unit: results JSON matches the zod schema; compare finds fixed, broke and still failing on two fixtures, including an old file without `kind`.
- End-to-end (offline): `pnpm harness run examples/echo --concurrency 4` runs the sample answer and trace cases with a fake judge, exit code 1 on a planted failure.

Acceptance: 20 cases on the echo adapter with a 5 s fake delay (`ECHO_DELAY_MS=5000`) finish in under 2 minutes at `--concurrency 8`; results order identical across two runs; the example registered check and trace case pass; compare of two runs prints the table above.

## Build plan (hackkit checkpoints)

Waves (across both repos): 1 = C1, C3, H1, M1; 2 = C2, C4, H2, M2; 3 = X1 (spans hackkit harness + agentmemory); 4 = M3.

| # | Checkpoint | Wave | Needs | Done-check |
|---|---|---|---|---|
| C1 | Workspace scaffold (pnpm, strict tsconfig, vitest) + connector core: types, errors, config, prices, log, Nebius chat | 1 | none | `pnpm -r typecheck` and fake-fetch tests pass; with key, one Nemotron reply and one log line |
| C2 | Meta provider + tools + json mode, and the `agy-cli` provider | 2 | C1 | Tests pass (fake fetch, fake agy script); live Muse Spark reply with a tool call; one live `agy-cli` call returns text |
| C3 | QlooClient (search, insights, tags) | 1 | none | Tests pass; live search for a film returns entities |
| C4 | Retries, fallback, embed(), smoke script | 2 | C1 | Smoke passes on all providers; killed-key run falls back |
| H1 | Harness loader, (ext) check registry with exact/contains/custom, (ext) worker pool with `--concurrency` and ordered results, table, results JSON, `.ts` adapter loading, `examples/echo` answer cases | 1 | none | `pnpm harness run examples/echo --concurrency 4`: same order twice, exit 1 on a planted fail |
| H2 | Judge check (as a registered plugin) + compare | 2 | H1, C1 | Judge tests pass; compare prints fixed/broke |
| X1 | Extensibility: Distiller/Merger/Retriever/LessonValidator interfaces + defaults via constructor; candidate status, minimal BasicValidator, promotion, approveLesson/rejectLesson, provenance; harness trace cases (RunAgent, 5 trace checks), `registerCheck` plugins, echo trace example | 3 | M2, H2 | Quarantine, validator, approve/reject and injected-part spy tests pass; echo trace case and the example registered check pass |

X1 in this repo = the harness half: trace cases (`RunAgent`, the 5 trace checks), `registerCheck` plugins and the echo trace example. The memory half lives in agentmemory.

> Before any live done-check, Tirth puts `NEBIUS_API_KEY`, `META_API_KEY`, `QLOO_API_KEY` in `.env` and makes sure agy is installed and logged in on the VM. Workers build against fakes until then.

## Risks and cut list

| Risk | Mitigation |
|---|---|
| Model IDs or hosts differ from the docs | Smoke test first; IDs live only in the calling repo's config |
| `openai` npm client misbehaves on Meta (tools, json) | Check in C2; fall back to plain `fetch` on the same endpoint |
| agy flags or model name change, or a huge prompt exceeds the per-argument size limit | Flags in one place in `agyCli.ts`; fail with a clear BadRequestError above 120 KB of prompt |
| better-sqlite3 native build fails on the VM | Install in M1 first; pnpm may need it allowed to run build scripts (to confirm) |
| Muse Spark reasoning is slow, runs take long | Judge on Nemotron; `--concurrency 8`; `--tag smoke` subset |
| Nebius `json_object` not supported on a model | Prompt-only JSON plus repair attempt |
| Qloo key or params wrong, silent empty results | Log result counts; fixture test per entity type |
| Merge threshold wrong, duplicates or lost lessons | 30 labelled pairs test; threshold is in MemoryConfig |
| Distiller writes vague lessons | Require cited event ids; cap confidence at 0.7 |
| Quarantine too strict, no lesson ever turns active | `trialSlots` lets candidates be used; lower `promoteAfterHelpedUses` to 1 or turn quarantine off |
| Extensibility work grows past use-and-throw size | One default per interface; no Postgres build; X1 is one worker task |

Cut in this order if short on time:

1. Harness compare JSON file (keep the printed table).
2. TS config file option (keep YAML only).
3. agy-cli wrapper option (keep the plain binary).
4. Trace check `order` and `args` matching (keep toolCalled, toolNotCalled, maxSteps, finalOutput).
5. Qloo `tags()` (keep search and insights).
6. Jaccard fallback (require an embedder).
7. Quarantine trial slots and auto-promotion (keep validator plus manual approve).
8. Judge check (keep exact, contains, custom).
9. Merger replace path (keep strengthen and insert).

Never cut: retries and fallback, call logging, scope filtering, validator on new lessons, real delete in `forget`, keys only in `.env`.

## To confirm

- **Nebius host per model**: Global vs `us-central1` URL
- **Nebius json mode**: `response_format` json_object per Nemotron model
- **openai npm on Meta**: Chat, tools, json mode through the SDK (docs show it for models.list)
- **Embeddings in Meta-only setups**: `embed()` needs a Nebius key; acceptable?
- **"Muse Code" model**: Product, not an API ID; use `muse-wonder-1.0`?
- **Qloo search params**: `types` vs `type`; `take` max 50; rate limits unpublished
- **agy CLI**: Flags `--dangerously-skip-permissions -p --model` and model name `gemini-3.8-flash-high`, as given by Tirth
- **Prompt size for agy**: Linux caps a single argument (about 128 KB); confirm on the VM
- **Merge threshold**: 0.88 cosine / 0.6 Jaccard, by test
- **Recency constant**: 14 days
- **Quarantine defaults**: 2 helped uses to promote, 1 trial slot
- **pgvector dimensions**: Index size limit vs 4096-dim embeddings; use 1024 dims or halfvec (future PostgresStore)
- **tsx loader in harness**: Loading `.ts` adapters and check plugins from the built CLI
- **better-sqlite3 install**: Native build or prebuilt binary on the VM's Node version; pnpm build-script approval
- **npm package name**: `agentmemory` free on npm, or use a scope
- **Shared code in public repos**: Copy connector and harness into each project's `vendor/` before it goes public

## Sources

- [Nebius Token Factory API introduction](https://docs.tokenfactory.nebius.com/api-reference/introduction) (docs.tokenfactory.nebius.com)
- [Nebius Token Factory model catalog and prices](https://tokenfactory.nebius.com/model-catalog.md) (tokenfactory.nebius.com)
- [Nebius create embeddings](https://docs.tokenfactory.nebius.com/api-reference/inference/create-embeddings) (docs.tokenfactory.nebius.com)
- [Meta Model API models](https://dev.meta.ai/docs/models) (dev.meta.ai)
- [Meta pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits) (dev.meta.ai)
- [Meta error handling](https://dev.meta.ai/docs/error-handling) (dev.meta.ai)
- [Qloo public docs and OpenAPI](https://github.com/qloo/docs-public) (github.com)
- [Qloo hackathon key and base URL notice](https://qloo-hackathon.devpost.com/forum_topics/41339-notice-didn-t-get-your-api-key-or-is-your-api-key-not-working) (devpost.com)

