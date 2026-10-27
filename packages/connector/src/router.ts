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
import { ConnectorError, ConfigError, ProviderError } from "./errors.js";
import type { Provider } from "./providers/base.js";
import { NebiusProvider } from "./providers/nebius.js";

function getProvider(
  resolved: ResolvedModel,
  config: ConnectorConfig,
  opts?: ChatOptions,
): Provider {
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

export async function chat(
  model: string,
  messages: Message[],
  opts?: ChatOptions,
): Promise<Reply> {
  const callId = `c_${ulid()}`;
  const startTime = Date.now();
  const promptSha = computePromptSha(messages);
  const nMessages = messages.length;
  const nTools = opts?.tools?.length ?? 0;
  const jsonMode = Boolean(opts?.json);

  let config: ConnectorConfig;
  try {
    config = await getConfig();
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConfigError(`Failed to load connector config: ${(err as Error).message}`);
  }

  const project = opts?.project ?? process.env.CONNECTOR_PROJECT ?? config.project ?? null;
  const tag = opts?.tag ?? null;

  let resolved: ResolvedModel;
  try {
    resolved = resolveModel(model, config);
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const connectorErr =
      err instanceof ConnectorError ? err : new ConfigError((err as Error).message, { model });
    appendLog({
      ts: formatIsoWithOffset(new Date()),
      call_id: callId,
      project,
      tag,
      kind: "chat",
      requested: model,
      model,
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
      n_messages: nMessages,
      n_tools: nTools,
      json_mode: jsonMode,
      prompt_sha: promptSha,
      error: connectorErr.message,
    });
    throw connectorErr;
  }

  let provider: Provider;
  try {
    provider = getProvider(resolved, config, opts);
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const connectorErr =
      err instanceof ConnectorError ? err : new ConfigError((err as Error).message, { model: resolved.fullName });
    appendLog({
      ts: formatIsoWithOffset(new Date()),
      call_id: callId,
      project,
      tag,
      kind: "chat",
      requested: model,
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
      n_messages: nMessages,
      n_tools: nTools,
      json_mode: jsonMode,
      prompt_sha: promptSha,
      error: connectorErr.message,
    });
    throw connectorErr;
  }

  try {
    const result = await provider.chat(resolved.modelId, messages, opts);
    const latencyMs = Date.now() - startTime;
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
      attempt: 1,
      fallback_index: 0,
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
      fallbackUsed: false,
      attempts: 1,
      callId,
      raw: result.raw,
    });
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const connectorErr =
      err instanceof ConnectorError
        ? err
        : new ProviderError((err as Error).message, { model: resolved.fullName, cause: err });
    const status = connectorErr.opts.status ?? null;

    appendLog({
      ts: formatIsoWithOffset(new Date()),
      call_id: callId,
      project,
      tag,
      kind: "chat",
      requested: model,
      model: resolved.fullName,
      attempt: 1,
      fallback_index: 0,
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
}
