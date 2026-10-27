import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Table from "cli-table3";
import type { CaseResult, CaseResultJson, ResultsFile, ResultsSummary } from "./types.js";

export function formatIsoIst(date: Date = new Date()): string {
  const istOffsetMs = 330 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffsetMs);
  const iso = istDate.toISOString();
  return iso.replace("Z", "+05:30");
}

export function createRunId(model: string, date: Date = new Date()): string {
  const istOffsetMs = 330 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffsetMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = istDate.getUTCFullYear();
  const mm = pad(istDate.getUTCMonth() + 1);
  const dd = pad(istDate.getUTCDate());
  const hh = pad(istDate.getUTCHours());
  const min = pad(istDate.getUTCMinutes());
  const safeModel = model.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${yyyy}-${mm}-${dd}T${hh}${min}_${safeModel}`;
}

export function getGitSha(cwd?: string): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: cwd || process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

export function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((percentile / 100) * (sorted.length - 1))),
  );
  return Math.round(sorted[index] ?? 0);
}

export function loadCallCosts(logFilePath: string): Map<string, number> {
  const map = new Map<string, number>();
  if (!fs.existsSync(logFilePath)) return map;

  const content = fs.readFileSync(logFilePath, "utf8");
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.call_id === "string") {
        const cost = typeof obj.cost_usd === "number" ? obj.cost_usd : 0;
        map.set(obj.call_id, cost);
      }
    } catch {
      // Ignore unparseable lines in log files
    }
  }
  return map;
}

export function calculateCost(
  callIds: string[] | undefined,
  callCosts: Map<string, number>,
): number {
  if (!callIds || callIds.length === 0) return 0;
  let total = 0;
  for (const id of callIds) {
    const cost = callCosts.get(id);
    if (typeof cost === "number") {
      total += cost;
    }
  }
  return total;
}

export function formatTerminalReport(
  cases: CaseResult[],
  summary: ResultsSummary,
): string {
  const table = new Table({
    head: ["id", "kind", "status", "checks", "cost", "time"],
    colAligns: ["left", "left", "left", "left", "right", "right"],
  });

  const failures: { id: string; reasons: string[] }[] = [];

  for (const c of cases) {
    const status = c.error ? `ERROR (${c.error})` : (c.passed ? "PASS" : "FAIL");
    const passedChecks = c.checks.filter((chk) => chk.passed).length;
    const checksStr = c.checks.length > 0 ? `${passedChecks}/${c.checks.length}` : (c.error ? "-" : "0/0");
    const costStr = `$${c.costUsd.toFixed(4)}`;
    const timeStr = c.timeMs < 1000 ? `${c.timeMs}ms` : `${(c.timeMs / 1000).toFixed(2)}s`;

    table.push([c.id, c.kind, status, checksStr, costStr, timeStr]);

    if (!c.passed || c.error) {
      const reasons: string[] = [];
      if (c.error) {
        reasons.push(c.error);
      } else {
        for (const chk of c.checks) {
          if (!chk.passed) {
            reasons.push(`${chk.type}: ${chk.reason || "check failed"}`);
          }
        }
      }
      failures.push({ id: c.id, reasons });
    }
  }

  let output = table.toString() + "\n";

  if (failures.length > 0) {
    output += "\nFailures:\n";
    for (const f of failures) {
      output += `  ${f.id}:\n`;
      for (const r of f.reasons) {
        output += `    - ${r}\n`;
      }
    }
    output += "\n";
  }

  const passPct = (summary.pass_rate * 100).toFixed(1);
  const wallTimeStr = `${summary.wall_time_s.toFixed(2)}s`;
  const totalCostStr = `$${summary.cost_usd.toFixed(4)}`;
  const judgeCostStr = `$${summary.judge_cost_usd.toFixed(4)}`;

  output += `Summary: ${summary.passed}/${summary.total} passed (${passPct}%) | Cost: ${totalCostStr} | Judge cost: ${judgeCostStr} | Wall time: ${wallTimeStr}\n`;

  return output;
}

export function writeResultsJson(projectDir: string, results: ResultsFile): string {
  const resultsDir = path.resolve(projectDir, "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = path.resolve(resultsDir, `${results.run_id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf8");
  return outPath;
}
