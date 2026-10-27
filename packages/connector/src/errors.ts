export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly opts: { model?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
  }
}

/** Missing key, unknown alias, bad config, CLI binary not found. Never retried. */
export class ConfigError extends ConnectorError {}

/** 401/403. Not retried, straight to fallback. */
export class AuthError extends ConnectorError {}

/** 400/404/413/422, or tools sent to the CLI provider. Not retried, no fallback. */
export class BadRequestError extends ConnectorError {}

/** 429. Retried. */
export class RateLimitError extends ConnectorError {
  retryAfterMs?: number;
}

/** Timeout or connection reset. Retried. */
export class ProviderTimeout extends ConnectorError {}

/** 5xx; CLI provider non-zero exit or timeout. */
export class ProviderError extends ConnectorError {
  /** CLI provider: last 4 KB of stderr. */
  stderr?: string;
  exitCode?: number | null;
}

/** json: true and the reply text did not parse. */
export class BadJSONError extends ConnectorError {
  rawText = "";
}

/** Every model in the chain failed. */
export class AllModelsFailed extends ConnectorError {
  attempts: { model: string; errorType: string; status?: number; message: string }[] = [];
}

/** Qloo errors, same status mapping. */
export class QlooError extends ConnectorError {}
