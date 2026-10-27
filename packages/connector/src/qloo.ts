import { ConfigError, QlooError } from "./errors.js";

export interface QlooEntity {
  entity_id: string;
  name: string;
  types?: string[] | undefined;
  properties?: Record<string, unknown> | undefined;
  tags?: { id?: string | undefined; name: string }[] | undefined;
}

export interface QlooTag {
  id: string;
  name: string;
  type?: string | undefined;
}

export interface QlooInsightsOptions {
  entities?: string[] | undefined;
  tags?: string[] | undefined;
  locationQuery?: string | undefined;
  take?: number | undefined;
  extra?: Record<string, string> | undefined;
}

export interface QlooClientOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  fetch?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  jitter?: boolean | undefined;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header || !header.trim()) return undefined;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return Math.max(0, diff);
  }
  return undefined;
}

function isTimeoutOrNetworkError(err: unknown): boolean {
  if (err instanceof Error) {
    if (
      err.name === "TimeoutError" ||
      err.name === "AbortError" ||
      /timeout/i.test(err.message) ||
      /abort/i.test(err.message) ||
      /econnreset/i.test(err.message) ||
      /fetch failed/i.test(err.message)
    ) {
      return true;
    }
    if ("cause" in err && err.cause instanceof Error) {
      return isTimeoutOrNetworkError(err.cause);
    }
  }
  return false;
}

function createQlooError(message: string, status?: number, cause?: unknown): QlooError {
  const opts: { status?: number; cause?: unknown } = {};
  if (status !== undefined) {
    opts.status = status;
  }
  if (cause !== undefined) {
    opts.cause = cause;
  }
  const err = new QlooError(message, opts);
  if (status !== undefined) {
    (err as { status?: number }).status = status;
  }
  return err;
}

export class QlooClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly jitter: boolean;

  constructor(opts?: QlooClientOptions) {
    const apiKey = opts?.apiKey ?? process.env["QLOO_API_KEY"];
    if (!apiKey || !apiKey.trim()) {
      throw new ConfigError("Missing required environment variable QLOO_API_KEY");
    }
    this.apiKey = apiKey;
    this.baseUrl = (opts?.baseUrl ?? "https://hackathon.api.qloo.com").replace(/\/+$/, "");
    this.timeoutMs = opts?.timeoutMs ?? 20000;
    this.fetchFn = opts?.fetch ?? globalThis.fetch;
    this.sleepFn = opts?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.jitter = opts?.jitter ?? true;
  }

  private async get(path: string, params: URLSearchParams, allow404 = false): Promise<Response | null> {
    const url = new URL(`${this.baseUrl}${path}`);
    const paramStr = params.toString();
    if (paramStr) {
      url.search = paramStr;
    }

    const headers: Record<string, string> = {
      "X-Api-Key": this.apiKey,
    };

    let lastError: unknown;
    let lastStatus: number | undefined;

    for (let attempt = 0; attempt <= 3; attempt++) {
      let response: Response;
      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        response = await this.fetchFn(url.toString(), {
          method: "GET",
          headers,
          signal,
        });
      } catch (err: unknown) {
        lastError = err;
        lastStatus = isTimeoutOrNetworkError(err) ? 408 : undefined;

        if (attempt < 3 && isTimeoutOrNetworkError(err)) {
          const baseBackoff = 500 * Math.pow(2, attempt);
          const jitterMs = this.jitter ? Math.random() * 500 : 0;
          const delay = Math.min(baseBackoff + jitterMs, 20000);
          await this.sleepFn(delay);
          continue;
        }

        throw createQlooError(
          `Qloo request failed: ${err instanceof Error ? err.message : String(err)}`,
          lastStatus,
          err,
        );
      }

      if (response.ok) {
        return response;
      }

      if (response.status === 404 && allow404) {
        return null;
      }

      let errorText = "";
      try {
        errorText = await response.text();
      } catch {
        // ignore
      }

      lastStatus = response.status;
      const statusText = errorText.trim() ? errorText.trim() : response.statusText;

      // Non-retryable client errors: 401, 403, 400, 404 (when not allow404), 413, 422, etc.
      if (response.status < 500 && response.status !== 429) {
        throw createQlooError(
          `Qloo error ${response.status}: ${statusText || "Request failed"}`,
          response.status,
        );
      }

      // Retryable errors: 429 and 5xx
      if (attempt < 3) {
        const retryAfterHeader =
          response.headers.get("retry-after") ?? response.headers.get("Retry-After");
        const retryAfterMs = parseRetryAfter(retryAfterHeader);

        const baseBackoff = 500 * Math.pow(2, attempt);
        const jitterMs = this.jitter ? Math.random() * 500 : 0;
        let delay = baseBackoff + jitterMs;
        if (retryAfterMs !== undefined) {
          delay = Math.max(delay, retryAfterMs);
        }
        delay = Math.min(delay, 20000);

        await this.sleepFn(delay);
        continue;
      }

      // Exhausted 4 attempts on 429 or 5xx
      throw createQlooError(
        `Qloo error ${response.status}: ${statusText || "Request failed"}`,
        response.status,
      );
    }

    throw createQlooError("Qloo request failed after 4 attempts", lastStatus, lastError);
  }

  async search(query: string, types: string[], take = 6): Promise<QlooEntity[]> {
    const params = new URLSearchParams();
    params.set("query", query);
    params.set("types", types.join(","));
    params.set("take", String(take));

    const response = await this.get("/search", params, true);
    if (!response) {
      return [];
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err: unknown) {
      throw createQlooError("Failed to parse Qloo search response as JSON", response.status, err);
    }

    if (data && typeof data === "object") {
      if (Array.isArray((data as { results?: unknown }).results)) {
        return (data as { results: QlooEntity[] }).results;
      }
      if (Array.isArray(data)) {
        return data as QlooEntity[];
      }
    }
    return [];
  }

  async insights(filterType: string, opts?: QlooInsightsOptions): Promise<QlooEntity[]> {
    const params = new URLSearchParams();
    params.set("filter.type", filterType);

    if (opts?.entities && opts.entities.length > 0) {
      params.set("signal.interests.entities", opts.entities.join(","));
    }
    if (opts?.tags && opts.tags.length > 0) {
      params.set("filter.tags", opts.tags.join(","));
    }
    if (opts?.locationQuery) {
      params.set("filter.location.query", opts.locationQuery);
    }
    if (opts?.take !== undefined) {
      params.set("take", String(opts.take));
    }
    if (opts?.extra) {
      for (const [key, value] of Object.entries(opts.extra)) {
        params.set(key, value);
      }
    }

    const response = await this.get("/v2/insights", params, false);
    if (!response) {
      return [];
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err: unknown) {
      throw createQlooError("Failed to parse Qloo insights response as JSON", response.status, err);
    }

    if (data && typeof data === "object") {
      const results = (data as { results?: { entities?: unknown } }).results;
      if (results && typeof results === "object" && Array.isArray(results.entities)) {
        return results.entities as QlooEntity[];
      }
      const directEntities = (data as { entities?: unknown }).entities;
      if (Array.isArray(directEntities)) {
        return directEntities as QlooEntity[];
      }
      if (Array.isArray((data as { results?: unknown }).results)) {
        return (data as { results: QlooEntity[] }).results;
      }
      if (Array.isArray(data)) {
        return data as QlooEntity[];
      }
    }
    return [];
  }

  async tags(query: string, take?: number): Promise<QlooTag[]> {
    const params = new URLSearchParams();
    params.set("query", query);
    if (take !== undefined) {
      params.set("take", String(take));
    }

    const response = await this.get("/v2/tags", params, false);
    if (!response) {
      return [];
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err: unknown) {
      throw createQlooError("Failed to parse Qloo tags response as JSON", response.status, err);
    }

    if (data && typeof data === "object") {
      const results = (data as { results?: unknown }).results;
      if (Array.isArray(results)) {
        return results as QlooTag[];
      }
      if (results && typeof results === "object" && Array.isArray((results as { tags?: unknown }).tags)) {
        return (results as { tags: QlooTag[] }).tags;
      }
      const directTags = (data as { tags?: unknown }).tags;
      if (Array.isArray(directTags)) {
        return directTags as QlooTag[];
      }
      if (Array.isArray(data)) {
        return data as QlooTag[];
      }
    }
    return [];
  }
}
