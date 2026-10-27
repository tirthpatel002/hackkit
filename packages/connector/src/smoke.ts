import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { chat } from "./router.js";
import { embed } from "./embed.js";
import { QlooClient } from "./qloo.js";
import { getConfig } from "./config.js";

export interface SmokeCheck {
  id: string;
  provider: string;
  kind: string;
  run: () => Promise<string>;
}

export interface SmokeOptions {
  argv?: string[] | undefined;
  env?: Record<string, string | undefined> | undefined;
  out?: { log: (msg: string) => void; error?: (msg: string) => void } | undefined;
}

export async function runSmoke(
  argv: string[] = process.argv.slice(2),
  env?: Record<string, string | undefined>,
  out: { log: (msg: string) => void; error?: (msg: string) => void } = console,
): Promise<number> {
  const effectiveEnv = env ?? process.env;

  // Parse --only
  let onlyFilter: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only" && argv[i + 1]) {
      onlyFilter = argv[i + 1]!.trim().toLowerCase().replace(/[_:]/g, "-");
      i++;
    } else if (argv[i]?.startsWith("--only=")) {
      onlyFilter = argv[i]!.slice(7).trim().toLowerCase().replace(/[_:]/g, "-");
    }
  }

  const checks: {
    id: string;
    provider: string;
    kind: string;
    keyEnv?: string;
    checkSkip?: () => Promise<string | null> | (string | null);
    execute: () => Promise<string>;
  }[] = [
    {
      id: "nebius-chat",
      provider: "nebius",
      kind: "chat",
      keyEnv: "NEBIUS_API_KEY",
      checkSkip: () => {
        if (!effectiveEnv.NEBIUS_API_KEY) {
          return "skip (no NEBIUS_API_KEY)";
        }
        return null;
      },
      execute: async () => {
        const t0 = Date.now();
        const reply = await chat("main", [{ role: "user", content: "Reply with PONG only." }]);
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        if (reply.fallbackUsed) {
          return `AuthError -> fallback ${reply.model} ok  (fallbackUsed=true)`;
        }
        const modelId = reply.model.replace(/^nebius:/, "");
        const costStr = reply.costUsd !== null ? `$${reply.costUsd.toFixed(4)}` : "cost n/a";
        return `ok   ${modelId.padEnd(34)} ${sec}s  ${costStr}`;
      },
    },
    {
      id: "nebius-embed",
      provider: "nebius",
      kind: "embed",
      keyEnv: "NEBIUS_API_KEY",
      checkSkip: () => {
        if (!effectiveEnv.NEBIUS_API_KEY) {
          return "skip (no NEBIUS_API_KEY)";
        }
        return null;
      },
      execute: async () => {
        const t0 = Date.now();
        const res = await embed(["smoke test"]);
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        const modelDisplay = `Qwen/Qwen3-Embedding-8B dim=${res.dim}`;
        const costStr = res.costUsd !== null ? `$${res.costUsd.toFixed(4)}` : "$0.0000";
        return `ok   ${modelDisplay.padEnd(34)} ${sec}s  ${costStr}`;
      },
    },
    {
      id: "meta-chat",
      provider: "meta",
      kind: "chat",
      keyEnv: "META_API_KEY",
      checkSkip: () => {
        if (!effectiveEnv.META_API_KEY) {
          return "skip (no META_API_KEY)";
        }
        return null;
      },
      execute: async () => {
        const t0 = Date.now();
        const reply = await chat("meta:muse-spark-1.3", [{ role: "user", content: "Reply with PONG only." }]);
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        const modelId = reply.model.replace(/^meta:/, "");
        const costStr = reply.costUsd !== null ? `$${reply.costUsd.toFixed(4)}` : "cost n/a";
        return `ok   ${modelId.padEnd(34)} ${sec}s  ${costStr}`;
      },
    },
    {
      id: "agy-cli-chat",
      provider: "agy-cli",
      kind: "chat",
      checkSkip: async () => {
        const cfg = await getConfig();
        const bin = cfg.providers["agy-cli"].bin.replace(/^~/, os.homedir());
        if (!fs.existsSync(bin)) {
          return "skip (no agy bin)";
        }
        return null;
      },
      execute: async () => {
        const t0 = Date.now();
        const reply = await chat("agy-cli", [{ role: "user", content: "Reply with PONG only." }]);
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        const modelId = reply.model.replace(/^agy-cli:/, "");
        return `ok   ${modelId.padEnd(34)} ${sec}s  cost n/a`;
      },
    },
    {
      id: "qloo-search",
      provider: "qloo",
      kind: "search",
      keyEnv: "QLOO_API_KEY",
      checkSkip: () => {
        if (!effectiveEnv.QLOO_API_KEY) {
          return "skip (no QLOO_API_KEY)";
        }
        return null;
      },
      execute: async () => {
        const t0 = Date.now();
        const qloo = new QlooClient({ apiKey: effectiveEnv.QLOO_API_KEY });
        const res = await qloo.search("Dune", ["urn:entity:movie"], 6);
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        const summary = `"Dune" -> ${res.length} movies`;
        return `ok   ${summary.padEnd(34)} ${sec}s`;
      },
    },
  ];

  const filtered = onlyFilter
    ? checks.filter((c) => {
        return (
          c.id === onlyFilter ||
          c.id.includes(onlyFilter) ||
          c.provider === onlyFilter ||
          c.kind === onlyFilter
        );
      })
    : checks;

  if (filtered.length === 0) {
    out.log(`No checks matched --only ${onlyFilter}`);
    return 1;
  }

  let anyFailed = false;

  for (const check of filtered) {
    const pCol = check.provider.padEnd(8);
    const kCol = check.kind.padEnd(7);

    const skipReason = check.checkSkip ? await check.checkSkip() : null;
    if (skipReason) {
      out.log(`${pCol}${kCol}${skipReason}`);
      continue;
    }

    try {
      const details = await check.execute();
      out.log(`${pCol}${kCol}${details}`);
    } catch (err) {
      anyFailed = true;
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      out.log(`${pCol}${kCol}failed  ${msg}`);
    }
  }

  return anyFailed ? 1 : 0;
}

export const main = runSmoke;

// Direct execution
const isDirect =
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    process.argv[1].endsWith("/smoke.ts") ||
    process.argv[1].endsWith("\\smoke.ts"));

if (isDirect) {
  main().then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  });
}
