import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Message } from "./types.js";

export interface LogEntry {
  ts: string;
  call_id: string;
  project: string | null;
  tag: string | null;
  kind: "chat" | "embed" | "qloo";
  requested: string;
  model: string;
  attempt: number;
  fallback_index: number;
  status: "ok" | "retry" | "fallback" | "failed";
  error_type: string | null;
  http_status: number | null;
  tokens_in: number | null;
  tokens_cached: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  latency_ms: number;
  n_messages: number;
  n_tools: number;
  json_mode: boolean;
  prompt_sha: string;
  error: string | null;
  warning?: string | null | undefined;
  exit_code?: number | null | undefined;
}

export function formatIsoWithOffset(date: Date = new Date()): string {
  const tzOffset = -date.getTimezoneOffset();
  const sign = tzOffset >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const pad3 = (n: number) => String(Math.floor(Math.abs(n))).padStart(3, "0");
  const hours = pad(tzOffset / 60);
  const mins = pad(tzOffset % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad3(date.getMilliseconds())}${sign}${hours}:${mins}`;
}

export function computePromptSha(messages: Message[]): string {
  const hash = createHash("sha256");
  for (const m of messages) {
    hash.update(m.role);
    hash.update(":\n");
    hash.update(m.content ?? "");
    if (m.tool_call_id) {
      hash.update("\n[tool_call_id:");
      hash.update(m.tool_call_id);
      hash.update("]");
    }
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function appendLog(entry: LogEntry, logPath?: string): void {
  const targetPath =
    logPath ?? process.env.CONNECTOR_LOG ?? path.resolve(process.cwd(), "logs/calls.jsonl");
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(targetPath, JSON.stringify(entry) + "\n", "utf-8");
}
