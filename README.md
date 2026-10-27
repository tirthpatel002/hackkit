# hackkit

Private pnpm workspace with two shared TypeScript packages for the hackathon projects (Clearmind, Tastebud, Reflex):

- `packages/connector` (`@hackkit/connector`): one `chat()` and one `embed()` across Nebius Token Factory and Meta Model API, plus a `QlooClient`. Handles keys, retries, fallback, cost and call logging.
- `packages/harness` (`@hackkit/harness`): runs a project's YAML test cases against its agent, grades them (exact / contains / judge / custom), writes a results file, and compares two runs.

## Setup

```bash
pnpm install
cp .env.example .env   # fill in NEBIUS_API_KEY, META_API_KEY, QLOO_API_KEY (never commit .env)
pnpm typecheck && pnpm test
```

Tests never need real keys (HTTP is mocked). Live-provider tests run only with `LIVE=1 pnpm test` and the keys present.

Licence: MIT.
