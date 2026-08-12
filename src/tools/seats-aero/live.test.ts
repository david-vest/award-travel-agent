import { describe, it, expect, vi, beforeEach } from "vitest";
import { LiveSeatsAeroClient } from "./live";

const okResponse = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

describe("LiveSeatsAeroClient", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends the API key in the Partner-Authorization header", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okResponse({ data: [], count: 0, hasMore: false, cursor: 0 }));

    const client = new LiveSeatsAeroClient("test-key");
    await client.search({ origin_airport: "ORD", destination_airport: "NRT" });

    const [, init] = fetchSpy.mock.calls[0];
    expect((init?.headers as Record<string, string>)["Partner-Authorization"]).toBe(
      "test-key",
    );
  });

  it("captures rate-limit headers into quota state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse({ data: [], count: 0, hasMore: false, cursor: 0 }, {
        "x-ratelimit-limit": "1000",
        "x-ratelimit-remaining": "994",
        "x-ratelimit-reset": "3600",
      }),
    );

    const client = new LiveSeatsAeroClient("test-key");
    await client.search({ origin_airport: "ORD", destination_airport: "NRT" });

    expect(client.quota()).toEqual({ limit: 1000, remaining: 994, reset: 3600 });
  });

  it("retries on 429 and succeeds on a later attempt", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        okResponse({ data: [], count: 0, hasMore: false, cursor: 0 }),
      );

    const client = new LiveSeatsAeroClient("test-key", { baseDelayMs: 1 });
    await client.search({ origin_airport: "ORD", destination_airport: "NRT" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws a SeatsAeroError carrying the status on a non-retryable failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad request", { status: 400 }),
    );

    const client = new LiveSeatsAeroClient("test-key", { baseDelayMs: 1 });
    await expect(
      client.search({ origin_airport: "ORD", destination_airport: "NRT" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("omits undefined params from the query string", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okResponse({ data: [], count: 0, hasMore: false, cursor: 0 }));

    const client = new LiveSeatsAeroClient("test-key");
    await client.search({
      origin_airport: "ORD",
      destination_airport: "NRT",
      cursor: undefined,
    });

    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).not.toContain("cursor");
  });
});
