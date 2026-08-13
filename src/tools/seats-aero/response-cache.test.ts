import { describe, it, expect, vi } from "vitest";
import { withResponseCache, type CacheStore } from "./response-cache";
import type { SeatsAeroClient } from "./client";

function memoryStore(): CacheStore {
  const m = new Map<string, unknown>();
  return {
    async get(k) {
      return m.has(k) ? m.get(k) : undefined;
    },
    async set(k, v) {
      m.set(k, v);
    },
  };
}

function stubClient(overrides: Partial<SeatsAeroClient> = {}): SeatsAeroClient {
  return {
    search: vi.fn().mockResolvedValue({ data: [], count: 0, hasMore: false, cursor: 0 }),
    regionalAvailability: vi.fn().mockResolvedValue({ data: [], count: 0, hasMore: false, cursor: 0 }),
    trips: vi.fn().mockResolvedValue({ data: [] }),
    routes: vi.fn().mockResolvedValue([]),
    refresh: vi.fn().mockResolvedValue({ complete: true, items: [] }),
    quota: () => ({ limit: 1000, remaining: 1000, reset: 0 }),
    ...overrides,
  };
}

describe("withResponseCache", () => {
  it("calls through on a miss", async () => {
    const inner = stubClient();
    const cached = withResponseCache(inner, memoryStore());
    await cached.search({ origin_airport: "ORD", destination_airport: "NRT" });
    expect(inner.search).toHaveBeenCalledTimes(1);
  });

  it("serves the second identical call from cache", async () => {
    const inner = stubClient();
    const cached = withResponseCache(inner, memoryStore());
    const p = { origin_airport: "ORD", destination_airport: "NRT" };
    await cached.search(p);
    await cached.search(p);
    expect(inner.search).toHaveBeenCalledTimes(1);
  });

  it("treats differently-ordered params as the same request", async () => {
    const inner = stubClient();
    const cached = withResponseCache(inner, memoryStore());
    await cached.search({ origin_airport: "ORD", destination_airport: "NRT" });
    await cached.search({ destination_airport: "NRT", origin_airport: "ORD" });
    expect(inner.search).toHaveBeenCalledTimes(1);
  });

  it("never caches refresh — its purpose is to defeat staleness", async () => {
    const inner = stubClient();
    const cached = withResponseCache(inner, memoryStore());
    await cached.refresh(["a"]);
    await cached.refresh(["a"]);
    expect(inner.refresh).toHaveBeenCalledTimes(2);
  });

  it("passes quota straight through to the inner client", () => {
    const inner = stubClient({ quota: () => ({ limit: 5, remaining: 4, reset: 9 }) });
    const cached = withResponseCache(inner, memoryStore());
    expect(cached.quota()).toEqual({ limit: 5, remaining: 4, reset: 9 });
  });
});
