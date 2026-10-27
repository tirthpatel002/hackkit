import { createHash } from "node:crypto";
import OpenAI from "openai";
import { ulid } from "ulid";
import { getConfig, resolveModel, getProviderApiKey, type ConnectorConfig, type ResolvedModel } from "./config.js";
import { calculateCost } from "./prices.js";
import { appendLog, formatIsoWithOffset } from "./log.js";
import {
  ConnectorError,
  ConfigError,
  AuthError,
  BadRequestError,
  RateLimitError,
} from "./errors.js";
import { mapOpenAIError } from "./providers/openaiCompat.js";
import { computeBackoffMs, sleep } from "./backoff.js";
import type { EmbedOptions, EmbedResult } from "./types.js";

const BATCH_SIZE = 64;

export async function embed(
  texts: string[],
  opts?: EmbedOptions,
): Promise<EmbedResult> {
  const callId = `c_${ulid()}`;
  const startTime = Date.now();
  const requestedModel = opts?.model ?? "embed";
  const promptSha = createHash("sha256").update(texts.join("\n")).digest("hex");

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

  const project = process.env.CONNECTOR_PROJECT ?? config.project ?? null;

  let resolved: ResolvedModel;
  try {
    resolved = resolveModel(requestedModel, config);
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const connectorErr =
      err instanceof ConnectorError ? err : new ConfigError((err as Error).message, { model: requestedModel });
    appendLog({
      ts: formatIsoWithOffset(new Date()),
      call_id: callId,
      project,
      tag: "embed",
      kind: "embed",
      requested: requestedModel,
      model: requestedModel,
      attempt: 1,
      fallback_index: 0,
      status: "failed",
      error_type: connectorErr.name,
      http_status: null,
      tokens_in: null,
      tokens_cached: null,
      tokens_out: null,
      cost_usd: null,
      latency_ms: latencyMs,
      n_messages: texts.length,
      n_tools: 0,
      json_mode: false,
      prompt_sha: promptSha,
      error: connectorErr.message,
    });
    throw connectorErr;
  }

  let apiKey: string;
  try {
    apiKey = getProviderApiKey(resolved.provider, config);
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const connectorErr =
      err instanceof ConnectorError ? err : new ConfigError((err as Error).message, { model: resolved.fullName });
    appendLog({
      ts: formatIsoWithOffset(new Date()),
      call_id: callId,
      project,
      tag: "embed",
      kind: "embed",
      requested: requestedModel,
      model: resolved.fullName,
      attempt: 1,
      fallback_index: 0,
      status: "failed",
      error_type: connectorErr.name,
      http_status: null,
      tokens_in: null,
      tokens_cached: null,
      tokens_out: null,
      cost_usd: null,
      latency_ms: latencyMs,
      n_messages: texts.length,
      n_tools: 0,
      json_mode: false,
      prompt_sha: promptSha,
      error: connectorErr.message,
    });
    throw connectorErr;
  }

  const baseUrl =
    resolved.provider === "nebius"
      ? config.providers.nebius.baseUrl
      : resolved.provider === "meta"
        ? config.providers.meta.baseUrl
        : undefined;

  if (!baseUrl) {
    throw new ConfigError(`Embedding is not supported for provider "${resolved.provider}"`, {
      model: resolved.fullName,
    });
  }

  const timeout =
    resolved.provider === "nebius"
      ? (config.providers.nebius.timeoutMs ?? config.defaults.timeoutMs)
      : config.defaults.timeoutMs;

  const maxRetries = config.defaults.maxRetries ?? 3;

  const client = new OpenAI({
    baseURL: baseUrl,
    apiKey,
    maxRetries: 0,
    ...(timeout !== undefined ? { timeout } : {}),
    ...(opts?.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });

  if (texts.length === 0) {
    const emptyResult = Object.assign([], {
      dim: 0,
      dimensions: 0,
      tokensIn: 0,
      costUsd: 0,
      vectors: [],
    }) as EmbedResult;
    return emptyResult;
  }

  const allVectors: Float32Array[] = [];
  let totalTokensIn = 0;
  let attemptCount = 0;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batchTexts = texts.slice(i, i + BATCH_SIZE);
    let batchSucceeded = false;

    for (let retry = 0; retry <= maxRetries; retry++) {
      attemptCount++;
      const attemptStartTime = Date.now();

      if (opts?.signal?.aborted) {
        throw opts.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      }

      try {
        const body: OpenAI.Embeddings.EmbeddingCreateParams = {
          model: resolved.modelId,
          input: batchTexts,
          ...(opts?.dimensions !== undefined ? { dimensions: opts.dimensions } : {}),
        };

        const res = await client.embeddings.create(body, {
          signal: opts?.signal,
        });

        const sortedData = [...res.data].sort((a, b) => a.index - b.index);
        for (const item of sortedData) {
          allVectors.push(new Float32Array(item.embedding));
        }

        const batchTokens = res.usage?.prompt_tokens ?? res.usage?.total_tokens ?? 0;
        totalTokensIn += batchTokens;
        batchSucceeded = true;
        break;
      } catch (err) {
        const latencyMs = Date.now() - attemptStartTime;
        const connectorErr = mapOpenAIError(err, resolved.fullName);
        const status = connectorErr.opts.status ?? null;

        if (connectorErr instanceof BadRequestError || connectorErr instanceof AuthError) {
          appendLog({
            ts: formatIsoWithOffset(new Date()),
            call_id: callId,
            project,
            tag: "embed",
            kind: "embed",
            requested: requestedModel,
            model: resolved.fullName,
            attempt: attemptCount,
            fallback_index: 0,
            status: "failed",
            error_type: connectorErr.name,
            http_status: status,
            tokens_in: null,
            tokens_cached: null,
            tokens_out: null,
            cost_usd: null,
            latency_ms: latencyMs,
            n_messages: texts.length,
            n_tools: 0,
            json_mode: false,
            prompt_sha: promptSha,
            error: connectorErr.message,
          });
          throw connectorErr;
        }

        // Retryable error
        if (retry < maxRetries) {
          appendLog({
            ts: formatIsoWithOffset(new Date()),
            call_id: callId,
            project,
            tag: "embed",
            kind: "embed",
            requested: requestedModel,
            model: resolved.fullName,
            attempt: attemptCount,
            fallback_index: 0,
            status: "retry",
            error_type: connectorErr.name,
            http_status: status,
            tokens_in: null,
            tokens_cached: null,
            tokens_out: null,
            cost_usd: null,
            latency_ms: latencyMs,
            n_messages: texts.length,
            n_tools: 0,
            json_mode: false,
            prompt_sha: promptSha,
            error: connectorErr.message,
          });

          const retryAfterMs =
            connectorErr instanceof RateLimitError ? connectorErr.retryAfterMs : undefined;
          const delay = computeBackoffMs(retry, retryAfterMs);
          await sleep(delay, opts?.signal, opts?.sleep);
        } else {
          // Exhausted retries for this batch
          appendLog({
            ts: formatIsoWithOffset(new Date()),
            call_id: callId,
            project,
            tag: "embed",
            kind: "embed",
            requested: requestedModel,
            model: resolved.fullName,
            attempt: attemptCount,
            fallback_index: 0,
            status: "failed",
            error_type: connectorErr.name,
            http_status: status,
            tokens_in: null,
            tokens_cached: null,
            tokens_out: null,
            cost_usd: null,
            latency_ms: latencyMs,
            n_messages: texts.length,
            n_tools: 0,
            json_mode: false,
            prompt_sha: promptSha,
            error: connectorErr.message,
          });
          throw connectorErr;
        }
      }
    }

    if (!batchSucceeded) {
      break;
    }
  }

  const totalLatencyMs = Date.now() - startTime;
  const dim = allVectors[0]?.length ?? opts?.dimensions ?? 0;
  const { costUsd, priceMissing } = calculateCost(resolved.fullName, totalTokensIn, 0, 0);

  appendLog({
    ts: formatIsoWithOffset(new Date()),
    call_id: callId,
    project,
    tag: "embed",
    kind: "embed",
    requested: requestedModel,
    model: resolved.fullName,
    attempt: attemptCount > 0 ? attemptCount : 1,
    fallback_index: 0,
    status: "ok",
    error_type: null,
    http_status: 200,
    tokens_in: totalTokensIn,
    tokens_cached: 0,
    tokens_out: 0,
    cost_usd: costUsd,
    latency_ms: totalLatencyMs,
    n_messages: texts.length,
    n_tools: 0,
    json_mode: false,
    prompt_sha: promptSha,
    error: null,
    ...(priceMissing ? { warning: "price_missing" } : {}),
  });

  const result = Object.assign([...allVectors], {
    dim,
    dimensions: dim,
    tokensIn: totalTokensIn,
    costUsd,
    vectors: allVectors,
  }) as EmbedResult;

  return result;
}
