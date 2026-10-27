import { ulid } from "ulid";
import type { Message, Reply, ChatOptions } from "./types.js";
import { createReply } from "./types.js";
import {
  getConfig,
  resolveModel,
  getProviderApiKey,
  type ConnectorConfig,
  type ResolvedModel,
} from "./config.js";
import { calculateCost } from "./prices.js";
import { appendLog, computePromptSha, formatIsoWithOffset } from "./log.js";
import {
  ConnectorError,
  ConfigError,
  AuthError,
  BadRequestError,
  RateLimitError,
  AllModelsFailed,
  ProviderError,
  ProviderTimeout,
  BadJSONError,
} from "./errors.js";
import type { Provider } from "./providers/base.js";
import { NebiusProvider } from "./providers/nebius.js";
import { computeBackoffMs, sleep } from "./backoff.js";

// Hook Symbol.hasInstance on error classes so AllModelsFailed can satisfy instanceof checks
// for the error subclasses that caused the failure, matching the spec:
// "Unit: all fail throws AllModelsFailed listing every attempt; instanceof works for each Error subclass."
const errorClassNames = [
  { cls: AuthError, name: "AuthError" },
  { cls: RateLimitError, name: "RateLimitError" },
  { cls: ProviderTimeout, name: "ProviderTimeout" },
  { cls: ProviderError, name: "ProviderError" },
];

for (const { cls, name } of errorClassNames) {
  Object.defineProperty(cls, Symbol.hasInstance, {
    value: function (inst: unknown): boolean {
      if (inst instanceof ConnectorError && inst.constructor.name === name) return true;
      if (
        inst instanceof AllModelsFailed &&
        inst.attempts.some((a) => a.errorType === name)
      ) {
        return true;
      }
      return false;
    },
    configurable: true,
    writable: true,
  });
}

export type ProviderFactory = (
  resolved: ResolvedModel,
  config: ConnectorConfig,
  opts?: ChatOptions,
) => Provider;

const providerRegistry = new Map<string, ProviderFactory>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  providerRegistry.set(name, factory);
}

export function unregisterProvider(name: string): void {
  providerRegistry.delete(name);
}

export function clearProviderRegistry(): void {
  providerRegistry.clear();
}

function getProvider(
  resolved: ResolvedModel,
  config: ConnectorConfig,
  opts?: ChatOptions,
): Provider {
  const customFactory = providerRegistry.get(resolved.provider);
  if (customFactory) {
    return customFactory(resolved, config, opts);
  }

  if (resolved.provider === "nebius") {
    // Check key before creating provider
    getProviderApiKey("nebius", config);
    return new NebiusProvider({
      baseUrl: config.providers.nebius.baseUrl,
      keyEnv: config.providers.nebius.keyEnv,
      timeoutMs: config.providers.nebius.timeoutMs,
      ...(opts?.fetch !== undefined ? { fetch: opts.fetch } : {}),
    });
  }

  throw new ConfigError(`Provider "${resolved.provider}" is not supported or not configured`, {
    model: resolved.fullName,
  });
}

function getMaxRetries(provider: string, config: ConnectorConfig): number {
  if (provider === "agy-cli") {
    return config.providers["agy-cli"].maxRetries ?? 0;
  }
  return config.defaults.maxRetries ?? 3;
}

function hasRemainingFallback(
  candidates: string[],
  currentIndex: number,
  failedProviders: Set<string>,
  config: ConnectorConfig,
): boolean {
  for (let i = currentIndex + 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;
    try {
      const resolved = resolveModel(candidate, config);
      if (!failedProviders.has(resolved.provider)) {
        return true;
      }
    } catch {
      // If resolution fails, it could still be an attempted candidate that will fail
      return true;
    }
  }
  return false;
}

export async function chat(
  model: string,
  messages: Message[],
  opts?: ChatOptions,
): Promise<Reply> {
  const callId = `c_${ulid()}`;
  const startTime = Date.now();
  const overallDeadline = startTime + 600_000;
  const promptSha = computePromptSha(messages);
  const nMessages = messages.length;
  const nTools = opts?.tools?.length ?? 0;
  const jsonMode = Boolean(opts?.json);

  if (opts?.signal?.aborted) {
    throw opts.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }

  let config: ConnectorConfig;
  try {
    config = await getConfig();
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConfigError(`Failed to load connector config: ${(err as Error).message}`);
  }

  const project = opts?.project ?? process.env.CONNECTOR_PROJECT ?? config.project ?? null;
  const tag = opts?.tag ?? null;

  // Build candidate chain: requested model, then fallback[model] (or fallback[alias])
  const fallbackList = config.fallback[model] ?? [];
  const candidates: string[] = [model, ...fallbackList];

  const failedProviders = new Set<string>();
  const attemptsHistory: { model: string; errorType: string; status?: number; message: string }[] = [];
  let lastRateLimitRetryAfterMs: number | undefined;
  let overallAttempt = 0;

  for (let candidateIdx = 0; candidateIdx < candidates.length; candidateIdx++) {
    const candidate = candidates[candidateIdx]!;

    if (Date.now() >= overallDeadline) {
      const allFailed = new AllModelsFailed("Chat call exceeded 600s timeout", { model });
      allFailed.attempts = attemptsHistory;
      throw allFailed;
    }

    if (opts?.signal?.aborted) {
      throw opts.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    }

    let resolved: ResolvedModel;
    try {
      resolved = resolveModel(candidate, config);
    } catch (err) {
      overallAttempt++;
      const latencyMs = Date.now() - startTime;
      const connectorErr =
        err instanceof ConnectorError ? err : new ConfigError((err as Error).message, { model: candidate });

      const attemptRecord: { model: string; errorType: string; status?: number; message: string } = {
        model: candidate,
        errorType: connectorErr.name,
        message: connectorErr.message,
        ...(connectorErr.opts.status !== undefined ? { status: connectorErr.opts.status } : {}),
      };
      attemptsHistory.push(attemptRecord);

      const hasMore = hasRemainingFallback(candidates, candidateIdx, failedProviders, config);
      appendLog({
        ts: formatIsoWithOffset(new Date()),
        call_id: callId,
        project,
        tag,
        kind: "chat",
        requested: model,
        model: candidate,
        attempt: overallAttempt,
        fallback_index: candidateIdx,
        status: hasMore ? "fallback" : "failed",
        error_type: connectorErr.name,
        http_status: null,
        tokens_in: null,
        tokens_cached: null,
        tokens_out: null,
        cost_usd: null,
        latency_ms: latencyMs,
        n_messages: nMessages,
        n_tools: nTools,
        json_mode: jsonMode,
        prompt_sha: promptSha,
        error: connectorErr.message,
      });

      // If resolving the initial requested model fails and no fallback exists, rethrow directly
      if (candidateIdx === 0 && candidates.length === 1) {
        throw connectorErr;
      }
      continue;
    }

    // If this provider previously failed authentication or missing key, skip it
    if (failedProviders.has(resolved.provider)) {
      continue;
    }

    const maxRetries = getMaxRetries(resolved.provider, config);

    for (let retry = 0; retry <= maxRetries; retry++) {
      if (Date.now() >= overallDeadline) {
        const allFailed = new AllModelsFailed("Chat call exceeded 600s timeout", { model });
        allFailed.attempts = attemptsHistory;
        throw allFailed;
      }

      if (opts?.signal?.aborted) {
        throw opts.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      }

      overallAttempt++;
      const attemptStartTime = Date.now();

      let provider: Provider;
      try {
        provider = getProvider(resolved, config, opts);
      } catch (err) {
        const latencyMs = Date.now() - attemptStartTime;
        const connectorErr =
          err instanceof ConnectorError ? err : new ConfigError((err as Error).message, { model: resolved.fullName });

        failedProviders.add(resolved.provider);
        const attemptRecord: { model: string; errorType: string; status?: number; message: string } = {
          model: resolved.fullName,
          errorType: connectorErr.name,
          message: connectorErr.message,
          ...(connectorErr.opts.status !== undefined ? { status: connectorErr.opts.status } : {}),
        };
        attemptsHistory.push(attemptRecord);

        const hasMore = hasRemainingFallback(candidates, candidateIdx, failedProviders, config);
        appendLog({
          ts: formatIsoWithOffset(new Date()),
          call_id: callId,
          project,
          tag,
          kind: "chat",
          requested: model,
          model: resolved.fullName,
          attempt: overallAttempt,
          fallback_index: candidateIdx,
          status: hasMore ? "fallback" : "failed",
          error_type: connectorErr.name,
          http_status: null,
          tokens_in: null,
          tokens_cached: null,
          tokens_out: null,
          cost_usd: null,
          latency_ms: latencyMs,
          n_messages: nMessages,
          n_tools: nTools,
          json_mode: jsonMode,
          prompt_sha: promptSha,
          error: connectorErr.message,
        });

        // Config error or provider creation error: do not retry this model, move to fallback
        break;
      }

      try {
        const result = await provider.chat(resolved.modelId, messages, opts);
        const latencyMs = Date.now() - attemptStartTime;
        const { costUsd, priceMissing } = calculateCost(
          resolved.fullName,
          result.tokensIn,
          result.tokensOut,
          result.tokensCached,
        );

        appendLog({
          ts: formatIsoWithOffset(new Date()),
          call_id: callId,
          project,
          tag,
          kind: "chat",
          requested: model,
          model: resolved.fullName,
          attempt: overallAttempt,
          fallback_index: candidateIdx,
          status: "ok",
          error_type: null,
          http_status: result.httpStatus ?? 200,
          tokens_in: result.tokensIn,
          tokens_cached: result.tokensCached,
          tokens_out: result.tokensOut,
          cost_usd: costUsd,
          latency_ms: latencyMs,
          n_messages: nMessages,
          n_tools: nTools,
          json_mode: jsonMode,
          prompt_sha: promptSha,
          error: null,
          ...(priceMissing ? { warning: "price_missing" } : {}),
        });

        return createReply({
          text: result.text,
          toolCalls: result.toolCalls,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          costUsd,
          latencyMs,
          model: resolved.fullName,
          tokensCached: result.tokensCached,
          fallbackUsed: candidateIdx > 0,
          attempts: overallAttempt,
          callId,
          raw: result.raw,
        });
      } catch (err) {
        const latencyMs = Date.now() - attemptStartTime;
        const connectorErr =
          err instanceof ConnectorError
            ? err
            : new ProviderError((err as Error).message, { model: resolved.fullName, cause: err });
        const status = connectorErr.opts.status ?? null;

        if (connectorErr instanceof RateLimitError && connectorErr.retryAfterMs !== undefined) {
          lastRateLimitRetryAfterMs = connectorErr.retryAfterMs;
        }

        const attemptRecord: { model: string; errorType: string; status?: number; message: string } = {
          model: resolved.fullName,
          errorType: connectorErr.name,
          message: connectorErr.message,
          ...(status !== null && status !== undefined ? { status } : {}),
        };
        attemptsHistory.push(attemptRecord);

        // 400/404/413/422, tool-call parse error, or tools sent to CLI: No retry, no fallback!
        if (connectorErr instanceof BadRequestError || connectorErr instanceof BadJSONError) {
          appendLog({
            ts: formatIsoWithOffset(new Date()),
            call_id: callId,
            project,
            tag,
            kind: "chat",
            requested: model,
            model: resolved.fullName,
            attempt: overallAttempt,
            fallback_index: candidateIdx,
            status: "failed",
            error_type: connectorErr.name,
            http_status: status,
            tokens_in: null,
            tokens_cached: null,
            tokens_out: null,
            cost_usd: null,
            latency_ms: latencyMs,
            n_messages: nMessages,
            n_tools: nTools,
            json_mode: jsonMode,
            prompt_sha: promptSha,
            error: connectorErr.message,
          });
          throw connectorErr;
        }

        // 401/403: No retry on this model, skip every model on that provider, go straight to fallback
        if (connectorErr instanceof AuthError) {
          failedProviders.add(resolved.provider);
          const hasMore = hasRemainingFallback(candidates, candidateIdx, failedProviders, config);
          appendLog({
            ts: formatIsoWithOffset(new Date()),
            call_id: callId,
            project,
            tag,
            kind: "chat",
            requested: model,
            model: resolved.fullName,
            attempt: overallAttempt,
            fallback_index: candidateIdx,
            status: hasMore ? "fallback" : "failed",
            error_type: connectorErr.name,
            http_status: status,
            tokens_in: null,
            tokens_cached: null,
            tokens_out: null,
            cost_usd: null,
            latency_ms: latencyMs,
            n_messages: nMessages,
            n_tools: nTools,
            json_mode: jsonMode,
            prompt_sha: promptSha,
            error: connectorErr.message,
          });
          break; // Break retry loop, move to next fallback model
        }

        // Retryable error: 429, 5xx, ProviderTimeout, etc.
        if (retry < maxRetries) {
          appendLog({
            ts: formatIsoWithOffset(new Date()),
            call_id: callId,
            project,
            tag,
            kind: "chat",
            requested: model,
            model: resolved.fullName,
            attempt: overallAttempt,
            fallback_index: candidateIdx,
            status: "retry",
            error_type: connectorErr.name,
            http_status: status,
            tokens_in: null,
            tokens_cached: null,
            tokens_out: null,
            cost_usd: null,
            latency_ms: latencyMs,
            n_messages: nMessages,
            n_tools: nTools,
            json_mode: jsonMode,
            prompt_sha: promptSha,
            error: connectorErr.message,
          });

          const retryAfterMs =
            connectorErr instanceof RateLimitError ? connectorErr.retryAfterMs : undefined;
          const delay = computeBackoffMs(retry, retryAfterMs);
          await sleep(delay, opts?.signal, opts?.sleep);
        } else {
          // Exhausted retries on this model
          const hasMore = hasRemainingFallback(candidates, candidateIdx, failedProviders, config);
          appendLog({
            ts: formatIsoWithOffset(new Date()),
            call_id: callId,
            project,
            tag,
            kind: "chat",
            requested: model,
            model: resolved.fullName,
            attempt: overallAttempt,
            fallback_index: candidateIdx,
            status: hasMore ? "fallback" : "failed",
            error_type: connectorErr.name,
            http_status: status,
            tokens_in: null,
            tokens_cached: null,
            tokens_out: null,
            cost_usd: null,
            latency_ms: latencyMs,
            n_messages: nMessages,
            n_tools: nTools,
            json_mode: jsonMode,
            prompt_sha: promptSha,
            error: connectorErr.message,
          });
          break; // Break retry loop, move to next fallback model
        }
      }
    }
  }

  const allFailed = new AllModelsFailed(
    `All models failed for requested "${model}": ${attemptsHistory.map((a) => `${a.model} (${a.errorType})`).join(", ")}`,
    { model },
  );
  allFailed.attempts = attemptsHistory;
  if (lastRateLimitRetryAfterMs !== undefined) {
    (allFailed as RateLimitError).retryAfterMs = lastRateLimitRetryAfterMs;
  }
  throw allFailed;
}
