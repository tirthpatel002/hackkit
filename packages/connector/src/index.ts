export {
  chat,
  registerProvider,
  unregisterProvider,
  clearProviderRegistry,
  type ProviderFactory,
} from "./router.js";
export { embed } from "./embed.js";
export {
  computeBackoffMs,
  parseRetryAfter,
  sleep,
  type BackoffOptions,
} from "./backoff.js";
export {
  defineConfig,
  parseConfig,
  loadConfig,
  loadConfigSync,
  getConfig,
  setConfig,
  resolveModel,
  getProviderApiKey,
  DEFAULT_ALIASES,
  DEFAULT_FALLBACK,
  type ConnectorConfig,
  type ConnectorConfigInput,
  type ResolvedModel,
} from "./config.js";
export {
  calculateCost,
  getPrice,
  loadPrices,
  getPriceTable,
  setPriceTable,
  type PriceRow,
  type CostResult,
} from "./prices.js";
export {
  appendLog,
  computePromptSha,
  formatIsoWithOffset,
  type LogEntry,
} from "./log.js";
export * from "./types.js";
export * from "./errors.js";
export {
  type Provider,
  type ProviderChatResult,
} from "./providers/base.js";
export {
  OpenAICompatProvider,
  type OpenAICompatConfig,
  mapOpenAIError,
} from "./providers/openaiCompat.js";
export {
  NebiusProvider,
  NEBIUS_DEFAULT_BASE_URL,
  NEBIUS_DEFAULT_KEY_ENV,
} from "./providers/nebius.js";
export {
  MetaProvider,
  META_DEFAULT_BASE_URL,
  META_DEFAULT_KEY_ENV,
} from "./providers/meta.js";
export {
  AgyCliProvider,
  agyChat,
  flatten,
  label,
  parseBestEffortJson,
  type AgyConfig,
} from "./providers/agyCli.js";
export {
  QlooClient,
  type QlooEntity,
  type QlooTag,
  type QlooInsightsOptions,
  type QlooClientOptions,
} from "./qloo.js";
