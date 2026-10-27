import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { ulid } from "ulid";
import type { Message, Reply, ChatOptions } from "../types.js";
import { createReply } from "../types.js";
import type { Provider, ProviderChatResult } from "./base.js";
import { BadRequestError, ConfigError, ProviderError, BadJSONError } from "../errors.js";

export interface AgyConfig {
  bin: string;
  wrapper: string[];
  defaultModel: string;
  timeoutMs: number;
  maxRetries: number;
}

export function label(m: Message): string {
  if (m.role === "tool") {
    return m.tool_call_id ? `TOOL RESULT ${m.tool_call_id}` : "TOOL RESULT";
  }
  return m.role.toUpperCase();
}

export function flatten(messages: Message[]): string {
  // "SYSTEM:\n...\n\nUSER:\n...\n\nASSISTANT:\n..." (tool messages as "TOOL RESULT <id>:")
  return messages.map((m) => `${label(m)}:\n${m.content ?? ""}`).join("\n\n");
}

export function parseBestEffortJson<T = unknown>(text: string, model: string): T {
  const trimmed = text.trim();

  // 1. Try whole text
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // continue
  }

  // 2. Try markdown code fence
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as T;
    } catch {
      // continue
    }
  }

  const anyFenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (anyFenceMatch && anyFenceMatch[1]) {
    try {
      return JSON.parse(anyFenceMatch[1].trim()) as T;
    } catch {
      // continue
    }
  }

  // 3. Try parsing from first { or [ to last } or ]
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket && firstBracket < firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBracket, lastBracket + 1)) as T;
      } catch {
        // Fall through to try brace
      }
    }
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as T;
    } catch {
      // continue
    }
  }

  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(trimmed.slice(firstBracket, lastBracket + 1)) as T;
    } catch {
      // continue
    }
  }

  const bad = new BadJSONError("Failed to parse reply text as JSON", { model });
  bad.rawText = text;
  throw bad;
}

export async function agyChat(
  model: string,
  messages: Message[],
  opts: ChatOptions = {},
  cfg: AgyConfig,
): Promise<Reply> {
  if (opts.tools && opts.tools.length > 0) {
    throw new BadRequestError("tools are not supported on agy-cli");
  }

  let prompt = flatten(messages);
  if (opts.json) {
    prompt += "\n\nReply with one JSON value only, no other text.";
  }

  // 120 KB limit on prompt
  if (Buffer.byteLength(prompt, "utf-8") > 120 * 1024) {
    throw new BadRequestError("Prompt exceeds maximum size limit of 120 KB for agy-cli");
  }

  const agyModel =
    (model.includes(":")
      ? model.slice(model.indexOf(":") + 1)
      : model === "agy-cli"
        ? cfg.defaultModel
        : model) || cfg.defaultModel;

  const bin = cfg.bin.replace(/^~/, homedir());
  const args = ["--dangerously-skip-permissions", "-p", prompt, "--model", agyModel];
  const fullCmd = cfg.wrapper.length > 0 ? [...cfg.wrapper, bin] : [bin];
  const cmd = fullCmd[0]!;
  const pre = fullCmd.slice(1);

  return new Promise<Reply>((resolve, reject) => {
    const startTime = Date.now();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, [...pre, ...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(new ConfigError(`agy not found at ${cmd}`, { model: `agy-cli:${agyModel}`, cause: err }));
      } else {
        reject(new ProviderError((err as Error).message, { model: `agy-cli:${agyModel}`, cause: err }));
      }
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    }

    let timer: NodeJS.Timeout | null = null;
    let killed = false;
    let settled = false;

    const killChild = () => {
      if (!killed) {
        killed = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // Process already exited
        }
      }
    };

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (opts.signal) {
        opts.signal.removeEventListener("abort", onAbort);
      }
    };

    const onAbort = () => {
      if (!settled) {
        settled = true;
        killChild();
        cleanup();
        reject(new ProviderError("timeout", { model: `agy-cli:${agyModel}` }));
      }
    };

    const timeout = opts.timeoutMs ?? cfg.timeoutMs;
    if (timeout > 0 && timeout < Infinity) {
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          killChild();
          cleanup();
          reject(new ProviderError("timeout", { model: `agy-cli:${agyModel}` }));
        }
      }, timeout);
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        settled = true;
        killChild();
        cleanup();
        reject(new ProviderError("timeout", { model: `agy-cli:${agyModel}` }));
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        cleanup();
        if (err.code === "ENOENT") {
          reject(new ConfigError(`agy not found at ${cmd}`, { model: `agy-cli:${agyModel}`, cause: err }));
        } else {
          reject(new ProviderError(err.message, { model: `agy-cli:${agyModel}`, cause: err }));
        }
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        cleanup();

        if (code !== 0) {
          const stderrBuffer = Buffer.concat(stderrChunks);
          const lastStderr = stderrBuffer.length > 4096 ? stderrBuffer.subarray(-4096) : stderrBuffer;
          const stderrStr = lastStderr.toString("utf-8");
          const providerErr = new ProviderError(
            `agy exited with code ${code ?? "null"}: ${stderrStr.trim() || "unknown error"}`,
            { model: `agy-cli:${agyModel}` },
          );
          providerErr.exitCode = code;
          providerErr.stderr = stderrStr;
          reject(providerErr);
          return;
        }

        const stdoutStr = Buffer.concat(stdoutChunks).toString("utf-8").trim();
        const latencyMs = Date.now() - startTime;
        const callId = `c_${ulid()}`;

        const reply = createReply({
          text: stdoutStr,
          toolCalls: [],
          tokensIn: null,
          tokensOut: null,
          tokensCached: null,
          costUsd: null,
          latencyMs,
          model: `agy-cli:${agyModel}`,
          fallbackUsed: false,
          attempts: 1,
          callId,
          raw: { stdout: stdoutStr, exitCode: 0 },
          json<T>(): T {
            const currentText = typeof this?.text === "string" ? this.text : stdoutStr;
            const currentModel = typeof this?.model === "string" ? this.model : `agy-cli:${agyModel}`;
            return parseBestEffortJson<T>(currentText, currentModel);
          },
        });
        resolve(reply);
      }
    });
  });
}

export class AgyCliProvider implements Provider {
  readonly name = "agy-cli";

  constructor(readonly cfg: AgyConfig) {}

  async chat(
    modelId: string,
    messages: Message[],
    opts?: ChatOptions,
  ): Promise<ProviderChatResult> {
    const reply = await agyChat(modelId, messages, opts ?? {}, this.cfg);
    return {
      text: reply.text,
      toolCalls: reply.toolCalls,
      tokensIn: reply.tokensIn,
      tokensOut: reply.tokensOut,
      tokensCached: reply.tokensCached,
      raw: reply.raw,
      exitCode: 0,
      json: reply.json.bind(reply),
    };
  }
}
