import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import {
  ConnectorError,
  ConfigError,
  AuthError,
  BadRequestError,
  RateLimitError,
  ProviderTimeout,
  ProviderError,
  BadJSONError,
  AllModelsFailed,
  QlooError,
} from "../src/index.js";
import { mapOpenAIError } from "../src/providers/openaiCompat.js";

describe("errors", () => {
  it("verifies instanceof hierarchy for all ConnectorError subclasses", () => {
    const configErr = new ConfigError("bad config");
    expect(configErr).toBeInstanceOf(ConnectorError);
    expect(configErr).toBeInstanceOf(ConfigError);
    expect(configErr.name).toBe("ConfigError");

    const authErr = new AuthError("unauthorized");
    expect(authErr).toBeInstanceOf(ConnectorError);
    expect(authErr).toBeInstanceOf(AuthError);
    expect(authErr.name).toBe("AuthError");

    const badReqErr = new BadRequestError("bad request");
    expect(badReqErr).toBeInstanceOf(ConnectorError);
    expect(badReqErr).toBeInstanceOf(BadRequestError);
    expect(badReqErr.name).toBe("BadRequestError");

    const rateErr = new RateLimitError("rate limited");
    expect(rateErr).toBeInstanceOf(ConnectorError);
    expect(rateErr).toBeInstanceOf(RateLimitError);
    expect(rateErr.name).toBe("RateLimitError");

    const timeoutErr = new ProviderTimeout("timed out");
    expect(timeoutErr).toBeInstanceOf(ConnectorError);
    expect(timeoutErr).toBeInstanceOf(ProviderTimeout);
    expect(timeoutErr.name).toBe("ProviderTimeout");

    const provErr = new ProviderError("internal error");
    expect(provErr).toBeInstanceOf(ConnectorError);
    expect(provErr).toBeInstanceOf(ProviderError);
    expect(provErr.name).toBe("ProviderError");

    const badJson = new BadJSONError("bad json");
    expect(badJson).toBeInstanceOf(ConnectorError);
    expect(badJson).toBeInstanceOf(BadJSONError);
    expect(badJson.name).toBe("BadJSONError");

    const allFailed = new AllModelsFailed("all failed");
    expect(allFailed).toBeInstanceOf(ConnectorError);
    expect(allFailed).toBeInstanceOf(AllModelsFailed);
    expect(allFailed.name).toBe("AllModelsFailed");

    const qlooErr = new QlooError("qloo failed");
    expect(qlooErr).toBeInstanceOf(ConnectorError);
    expect(qlooErr).toBeInstanceOf(QlooError);
    expect(qlooErr.name).toBe("QlooError");
  });

  it("maps 401 and 403 to AuthError", () => {
    const err401 = new OpenAI.APIError(401, { error: { message: "Invalid API key" } }, "Invalid API key", new Headers());
    const mapped401 = mapOpenAIError(err401, "nebius:test");
    expect(mapped401).toBeInstanceOf(AuthError);
    expect(mapped401.opts.status).toBe(401);

    const err403 = new OpenAI.APIError(403, { error: { message: "Forbidden" } }, "Forbidden", new Headers());
    const mapped403 = mapOpenAIError(err403, "nebius:test");
    expect(mapped403).toBeInstanceOf(AuthError);
    expect(mapped403.opts.status).toBe(403);
  });

  it("maps 400, 404, 413, 422 to BadRequestError", () => {
    for (const code of [400, 404, 413, 422]) {
      const err = new OpenAI.APIError(code, { error: { message: `Code ${code}` } }, `Code ${code}`, new Headers());
      const mapped = mapOpenAIError(err, "nebius:test");
      expect(mapped).toBeInstanceOf(BadRequestError);
      expect(mapped.opts.status).toBe(code);
    }
  });

  it("maps 429 to RateLimitError and parses Retry-After header", () => {
    const headers = new Headers();
    headers.set("retry-after", "5");
    const err429 = new OpenAI.APIError(429, { error: { message: "Too many requests" } }, "Too many requests", headers);
    const mapped = mapOpenAIError(err429, "nebius:test");
    expect(mapped).toBeInstanceOf(RateLimitError);
    expect(mapped.opts.status).toBe(429);
    expect((mapped as RateLimitError).retryAfterMs).toBe(5000);
  });

  it("maps 500 and 5xx to ProviderError", () => {
    for (const code of [500, 502, 503, 504]) {
      const err = new OpenAI.APIError(code, { error: { message: `Server error ${code}` } }, `Server error ${code}`, new Headers());
      const mapped = mapOpenAIError(err, "nebius:test");
      expect(mapped).toBeInstanceOf(ProviderError);
      expect(mapped.opts.status).toBe(code);
    }
  });

  it("maps timeout and connection errors to ProviderTimeout", () => {
    const timeoutErr = new OpenAI.APIConnectionTimeoutError({ message: "Request timed out" });
    const mappedTimeout = mapOpenAIError(timeoutErr, "nebius:test");
    expect(mappedTimeout).toBeInstanceOf(ProviderTimeout);

    const connErr = new OpenAI.APIConnectionError({ message: "Connection refused" });
    const mappedConn = mapOpenAIError(connErr, "nebius:test");
    expect(mappedConn).toBeInstanceOf(ProviderTimeout);
  });
});
