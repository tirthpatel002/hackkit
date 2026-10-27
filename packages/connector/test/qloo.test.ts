import { describe, expect, it, vi } from "vitest";
import { ConfigError, QlooError } from "../src/errors.js";
import { QlooClient } from "../src/qloo.js";

function createMockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

describe("QlooClient constructor and config", () => {
  it("throws ConfigError naming QLOO_API_KEY when key is missing", () => {
    const prevKey = process.env["QLOO_API_KEY"];
    delete process.env["QLOO_API_KEY"];
    try {
      expect(() => new QlooClient()).toThrow(ConfigError);
      expect(() => new QlooClient()).toThrow(/QLOO_API_KEY/);
      expect(() => new QlooClient({ apiKey: "" })).toThrow(/QLOO_API_KEY/);
    } finally {
      if (prevKey !== undefined) {
        process.env["QLOO_API_KEY"] = prevKey;
      }
    }
  });

  it("reads QLOO_API_KEY from environment if not provided in opts", () => {
    const prevKey = process.env["QLOO_API_KEY"];
    process.env["QLOO_API_KEY"] = "env-secret-key";
    try {
      const client = new QlooClient();
      expect(client).toBeInstanceOf(QlooClient);
    } finally {
      if (prevKey !== undefined) {
        process.env["QLOO_API_KEY"] = prevKey;
      } else {
        delete process.env["QLOO_API_KEY"];
      }
    }
  });

  it("uses provided apiKey option over environment variable", async () => {
    let sentKey = "";
    const mockFetch = createMockFetch((_url, init) => {
      const headers = new Headers(init?.headers);
      sentKey = headers.get("X-Api-Key") ?? "";
      return new Response(JSON.stringify({ results: [] }));
    });

    const client = new QlooClient({ apiKey: "explicit-key", fetch: mockFetch });
    await client.search("test", ["urn:entity:movie"]);
    expect(sentKey).toBe("explicit-key");
  });

  it("strips trailing slash from baseUrl", async () => {
    let requestedUrl = "";
    const mockFetch = createMockFetch((url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ results: [] }));
    });

    const client = new QlooClient({
      apiKey: "test-key",
      baseUrl: "https://custom.api.qloo.com///",
      fetch: mockFetch,
    });
    await client.search("test", ["urn:entity:movie"]);
    expect(requestedUrl.startsWith("https://custom.api.qloo.com/search")).toBe(true);
  });
});

describe("QlooClient headers and query strings", () => {
  it("header carries the key", async () => {
    let sentHeaders: HeadersInit | undefined;
    const mockFetch = createMockFetch((_url, init) => {
      sentHeaders = init?.headers;
      return new Response(JSON.stringify({ results: [] }));
    });

    const client = new QlooClient({ apiKey: "test-key-abc", fetch: mockFetch });
    await client.search("Dune", ["urn:entity:movie"]);

    expect(sentHeaders).toBeDefined();
    const headers = new Headers(sentHeaders);
    expect(headers.get("X-Api-Key")).toBe("test-key-abc");
  });

  it("builds exact query string for search with defaults", async () => {
    let requestedUrl = "";
    const mockFetch = createMockFetch((url) => {
      requestedUrl = url;
      return new Response(
        JSON.stringify({
          results: [{ entity_id: "urn:entity:movie:1", name: "Dune" }],
        }),
      );
    });

    const client = new QlooClient({ apiKey: "test-key", fetch: mockFetch });
    const results = await client.search("Dune", ["urn:entity:movie"]);

    expect(results).toEqual([{ entity_id: "urn:entity:movie:1", name: "Dune" }]);
    const parsed = new URL(requestedUrl);
    expect(parsed.origin).toBe("https://hackathon.api.qloo.com");
    expect(parsed.pathname).toBe("/search");
    expect(parsed.searchParams.get("query")).toBe("Dune");
    expect(parsed.searchParams.get("types")).toBe("urn:entity:movie");
    expect(parsed.searchParams.get("take")).toBe("6");
    expect(parsed.search).toBe("?query=Dune&types=urn%3Aentity%3Amovie&take=6");
  });

  it("builds exact query string for search with multiple types and take", async () => {
    let requestedUrl = "";
    const mockFetch = createMockFetch((url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ results: [] }));
    });

    const client = new QlooClient({ apiKey: "test-key", fetch: mockFetch });
    await client.search("Star Wars", ["urn:entity:movie", "urn:entity:book"], 10);

    const parsed = new URL(requestedUrl);
    expect(parsed.searchParams.get("query")).toBe("Star Wars");
    expect(parsed.searchParams.get("types")).toBe("urn:entity:movie,urn:entity:book");
    expect(parsed.searchParams.get("take")).toBe("10");
    expect(parsed.search).toBe("?query=Star+Wars&types=urn%3Aentity%3Amovie%2Curn%3Aentity%3Abook&take=10");
  });

  it("builds exact query string for insights with filter.type, signal.interests.entities, filter.tags, filter.location.query, take, and extra", async () => {
    let requestedUrl = "";
    const mockFetch = createMockFetch((url) => {
      requestedUrl = url;
      return new Response(
        JSON.stringify({
          results: {
            entities: [{ entity_id: "urn:entity:movie:2", name: "Blade Runner" }],
          },
        }),
      );
    });

    const client = new QlooClient({ apiKey: "test-key", fetch: mockFetch });
    const entities = await client.insights("urn:entity:movie", {
      entities: ["urn:entity:movie:1", "urn:entity:movie:2"],
      tags: ["sci-fi", "cyberpunk"],
      locationQuery: "Tokyo",
      take: 8,
      extra: {
        "filter.release_year": "2024",
      },
    });

    expect(entities).toEqual([{ entity_id: "urn:entity:movie:2", name: "Blade Runner" }]);
    const parsed = new URL(requestedUrl);
    expect(parsed.pathname).toBe("/v2/insights");
    expect(parsed.searchParams.get("filter.type")).toBe("urn:entity:movie");
    expect(parsed.searchParams.get("signal.interests.entities")).toBe(
      "urn:entity:movie:1,urn:entity:movie:2",
    );
    expect(parsed.searchParams.get("filter.tags")).toBe("sci-fi,cyberpunk");
    expect(parsed.searchParams.get("filter.location.query")).toBe("Tokyo");
    expect(parsed.searchParams.get("take")).toBe("8");
    expect(parsed.searchParams.get("filter.release_year")).toBe("2024");
    expect(parsed.search).toBe(
      "?filter.type=urn%3Aentity%3Amovie&signal.interests.entities=urn%3Aentity%3Amovie%3A1%2Curn%3Aentity%3Amovie%3A2&filter.tags=sci-fi%2Ccyberpunk&filter.location.query=Tokyo&take=8&filter.release_year=2024",
    );
  });

  it("builds exact query string for tags with and without take", async () => {
    let requestedUrl = "";
    const mockFetch = createMockFetch((url) => {
      requestedUrl = url;
      return new Response(
        JSON.stringify({
          results: [{ id: "tag-1", name: "Sci-Fi", type: "genre" }],
        }),
      );
    });

    const client = new QlooClient({ apiKey: "test-key", fetch: mockFetch });

    const tagList = await client.tags("sci-fi", 15);
    expect(tagList).toEqual([{ id: "tag-1", name: "Sci-Fi", type: "genre" }]);
    const parsed1 = new URL(requestedUrl);
    expect(parsed1.pathname).toBe("/v2/tags");
    expect(parsed1.searchParams.get("query")).toBe("sci-fi");
    expect(parsed1.searchParams.get("take")).toBe("15");
    expect(parsed1.search).toBe("?query=sci-fi&take=15");

    await client.tags("rock");
    const parsed2 = new URL(requestedUrl);
    expect(parsed2.pathname).toBe("/v2/tags");
    expect(parsed2.searchParams.get("query")).toBe("rock");
    expect(parsed2.searchParams.get("take")).toBeNull();
    expect(parsed2.search).toBe("?query=rock");
  });
});

describe("QlooClient status code handling & 404 behavior", () => {
  it("404 search -> []", async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount++;
      return new Response("Not Found", { status: 404 });
    });

    const client = new QlooClient({ apiKey: "test-key", fetch: mockFetch });
    const results = await client.search("non-existent-film", ["urn:entity:movie"]);
    expect(results).toEqual([]);
    expect(callCount).toBe(1); // No retries
  });

  it("404 on insights throws QlooError status 404", async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount++;
      return new Response("Not Found", { status: 404 });
    });

    const client = new QlooClient({ apiKey: "test-key", fetch: mockFetch });
    await expect(client.insights("urn:entity:movie")).rejects.toThrow(QlooError);
    expect(callCount).toBe(1);

    try {
      await client.insights("urn:entity:movie");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(QlooError);
      const qerr = err as QlooError;
      expect(qerr.opts.status).toBe(404);
      expect((qerr as unknown as { status: number }).status).toBe(404);
    }
  });

  it("401 -> QlooError status 401 no retry", async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount++;
      return new Response("Unauthorized", { status: 401 });
    });

    const client = new QlooClient({ apiKey: "test-key", fetch: mockFetch });
    await expect(client.search("Dune", ["urn:entity:movie"])).rejects.toThrow(QlooError);
    expect(callCount).toBe(1);

    try {
      await client.search("Dune", ["urn:entity:movie"]);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(QlooError);
      const qerr = err as QlooError;
      expect(qerr.opts.status).toBe(401);
      expect((qerr as unknown as { status: number }).status).toBe(401);
    }
  });

  it("403 -> QlooError status 403 no retry", async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount++;
      return new Response("Forbidden", { status: 403 });
    });

    const client = new QlooClient({ apiKey: "test-key", fetch: mockFetch });
    await expect(client.tags("rock")).rejects.toThrow(QlooError);
    expect(callCount).toBe(1);

    try {
      await client.tags("rock");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(QlooError);
      const qerr = err as QlooError;
      expect(qerr.opts.status).toBe(403);
    }
  });

  it("400 -> QlooError status 400 no retry", async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount++;
      return new Response("Bad Request", { status: 400 });
    });

    const client = new QlooClient({ apiKey: "test-key", fetch: mockFetch });
    await expect(client.search("Dune", ["urn:entity:movie"])).rejects.toThrow(QlooError);
    expect(callCount).toBe(1);

    try {
      await client.search("Dune", ["urn:entity:movie"]);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(QlooError);
      const qerr = err as QlooError;
      expect(qerr.opts.status).toBe(400);
    }
  });
});

describe("QlooClient retries, backoff, and timeouts", () => {
  it("429 then 200 retries and honours Retry-After (injected sleep)", async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount++;
      if (callCount === 1) {
        return new Response("Rate limited", {
          status: 429,
          headers: { "Retry-After": "2" },
        });
      }
      return new Response(
        JSON.stringify({
          results: [{ entity_id: "urn:entity:movie:1", name: "Dune" }],
        }),
        { status: 200 },
      );
    });

    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new QlooClient({
      apiKey: "test-key",
      fetch: mockFetch,
      sleep,
      jitter: false,
    });

    const results = await client.search("Dune", ["urn:entity:movie"]);
    expect(results).toEqual([{ entity_id: "urn:entity:movie:1", name: "Dune" }]);
    expect(callCount).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // Retry-After: 2 -> 2000 ms, greater than baseBackoff 500 ms
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("429 then 200 retries and honours Retry-After (vi.useFakeTimers)", async () => {
    vi.useFakeTimers();
    try {
      let callCount = 0;
      const mockFetch = createMockFetch(() => {
        callCount++;
        if (callCount === 1) {
          return new Response("Rate limited", {
            status: 429,
            headers: { "Retry-After": "2" },
          });
        }
        return new Response(
          JSON.stringify({
            results: [{ entity_id: "urn:entity:movie:1", name: "Dune" }],
          }),
          { status: 200 },
        );
      });

      const client = new QlooClient({
        apiKey: "test-key",
        fetch: mockFetch,
        jitter: false,
      });

      const searchPromise = client.search("Dune", ["urn:entity:movie"]);

      await vi.advanceTimersByTimeAsync(2000);

      const results = await searchPromise;
      expect(results).toEqual([{ entity_id: "urn:entity:movie:1", name: "Dune" }]);
      expect(callCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("500 x4 -> throws after 4 attempts", async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount++;
      return new Response("Internal Server Error", { status: 500 });
    });

    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new QlooClient({
      apiKey: "test-key",
      fetch: mockFetch,
      sleep,
      jitter: false,
    });

    await expect(client.search("Dune", ["urn:entity:movie"])).rejects.toThrow(QlooError);
    expect(callCount).toBe(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 500); // 500 * 2^0
    expect(sleep).toHaveBeenNthCalledWith(2, 1000); // 500 * 2^1
    expect(sleep).toHaveBeenNthCalledWith(3, 2000); // 500 * 2^2

    try {
      callCount = 0;
      await client.search("Dune", ["urn:entity:movie"]);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(QlooError);
      const qerr = err as QlooError;
      expect(qerr.opts.status).toBe(500);
      expect((qerr as unknown as { status: number }).status).toBe(500);
    }
  });

  it("caps backoff delay at 20 seconds when Retry-After is large", async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount++;
      if (callCount === 1) {
        return new Response("Rate limited", {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      }
      return new Response(JSON.stringify({ results: [] }));
    });

    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new QlooClient({
      apiKey: "test-key",
      fetch: mockFetch,
      sleep,
      jitter: false,
    });

    await client.search("Dune", ["urn:entity:movie"]);
    expect(sleep).toHaveBeenCalledWith(20000);
  });

  it("retries on timeout error up to 3 times then throws after 4 attempts", async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount++;
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });

    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new QlooClient({
      apiKey: "test-key",
      fetch: mockFetch,
      sleep,
      jitter: false,
    });

    await expect(client.search("Dune", ["urn:entity:movie"])).rejects.toThrow(QlooError);
    expect(callCount).toBe(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("retries on timeout error and recovers on next attempt", async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      }
      return new Response(
        JSON.stringify({
          results: [{ entity_id: "urn:entity:movie:1", name: "Dune" }],
        }),
      );
    });

    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new QlooClient({
      apiKey: "test-key",
      fetch: mockFetch,
      sleep,
      jitter: false,
    });

    const results = await client.search("Dune", ["urn:entity:movie"]);
    expect(results).toEqual([{ entity_id: "urn:entity:movie:1", name: "Dune" }]);
    expect(callCount).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });
});

describe.runIf(Boolean(process.env["LIVE"] && process.env["QLOO_API_KEY"]))(
  "live QlooClient (runs only when LIVE=1 and QLOO_API_KEY is set)",
  () => {
    it("performs live search for a film", async () => {
      const client = new QlooClient();
      const results = await client.search("Dune", ["urn:entity:movie"], 3);
      expect(Array.isArray(results)).toBe(true);
      if (results.length > 0) {
        expect(results[0]?.entity_id).toBeDefined();
        expect(results[0]?.name).toBeDefined();
      }
    });
  },
);
