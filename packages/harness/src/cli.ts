#!/usr/bin/env node
import { register } from "tsx/esm/api";
register();

import { loadCases } from "./cases.js";
import { compare } from "./compare.js";
import { ConfigError } from "./errors.js";
import { listChecks } from "./registry.js";
import type { RunOptions } from "./types.js";
import {
  loadCheckPlugins,
  loadHarnessConfig,
  resolveProjectDir,
  run,
} from "./runner.js";

function parseArgs(args: string[]) {
  const flags: {
    cases?: string;
    model?: string;
    concurrency?: number;
    tags: string[];
    positional: string[];
  } = { tags: [], positional: [] };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--cases") {
      i++;
      const val = args[i];
      if (val !== undefined) flags.cases = val;
    } else if (arg === "--model") {
      i++;
      const val = args[i];
      if (val !== undefined) flags.model = val;
    } else if (arg === "--concurrency") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        const parsed = parseInt(val, 10);
        if (isNaN(parsed) || parsed <= 0) {
          throw new ConfigError(`Invalid --concurrency value: ${val}`);
        }
        flags.concurrency = parsed;
      }
    } else if (arg === "--tag") {
      i++;
      const val = args[i];
      if (val !== undefined) flags.tags.push(val);
    } else if (arg.startsWith("-")) {
      throw new ConfigError(`Unknown flag: ${arg}`);
    } else {
      flags.positional.push(arg);
    }
  }
  return flags;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const flags = parseArgs(argv);
  const command = flags.positional[0];

  if (!command) {
    console.error("Usage: harness <run|compare|list|list-checks> [project] [options]");
    return 2;
  }

  if (command === "run") {
    const project = flags.positional[1] || ".";
    const runOpts: RunOptions = {
      ...(flags.cases !== undefined ? { casesFile: flags.cases } : {}),
      ...(flags.model !== undefined ? { model: flags.model } : {}),
      ...(flags.concurrency !== undefined ? { concurrency: flags.concurrency } : {}),
      ...(flags.tags.length > 0 ? { tags: flags.tags } : {}),
    };
    const results = await run(project, runOpts);

    const hasFailures = results.summary.failed > 0 || results.summary.errored > 0;
    return hasFailures ? 1 : 0;
  }

  if (command === "compare") {
    const fileA = flags.positional[1];
    const fileB = flags.positional[2];
    if (!fileA || !fileB) {
      throw new ConfigError("Usage: harness compare <fileA.json> <fileB.json>");
    }
    await compare(fileA, fileB);
    return 0;
  }

  if (command === "list") {
    const project = flags.positional[1] || ".";
    const projectDir = resolveProjectDir(project);
    const config = loadHarnessConfig(projectDir);
    await loadCheckPlugins(config.check_plugins, projectDir);

    const casesPath = flags.cases ?? config.cases ?? "cases/";
    const cases = loadCases(casesPath, projectDir);

    console.log(`Cases in ${project} (${cases.length}):`);
    for (const c of cases) {
      const tagsStr = c.tags && c.tags.length > 0 ? ` [${c.tags.join(", ")}]` : "";
      console.log(`- ${c.id} (${c.kind ?? "answer"})${tagsStr}`);
    }
    return 0;
  }

  if (command === "list-checks") {
    const project = flags.positional[1];
    if (project) {
      try {
        const projectDir = resolveProjectDir(project);
        const config = loadHarnessConfig(projectDir);
        await loadCheckPlugins(config.check_plugins, projectDir);
      } catch {
        // If project resolution fails for list-checks, still list registered built-ins
      }
    }

    const checks = listChecks();
    console.log("Registered checks:");
    for (const chk of checks) {
      console.log(`- ${chk}`);
    }
    return 0;
  }

  throw new ConfigError(`Unknown command: "${command}". Expected run, compare, list, or list-checks.`);
}

// Only execute directly when run from CLI (not when imported in tests)
if (process.argv[1] && (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js"))) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      if (err instanceof ConfigError) {
        console.error(`ConfigError: ${err.message}`);
        process.exit(2);
      }
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    });
}
