import { describe, it, expect, vi } from "vitest";
import { withTracing } from "./traced";
import type { SeatsAeroClient } from "./client";

const stub = (): SeatsAeroClient => ({
  search: vi.fn().mockResolvedValue({ data: [{ ID: "x" }], count: 1, hasMore: false, cursor: 0 }),
  regionalAvailability: vi.fn().mockResolvedValue({ data: [], count: 0, hasMore: false, cursor: 0 }),
  trips: vi.fn().mockResolvedValue({ data: [] }),
  routes: vi.fn().mockResolvedValue([]),
  refresh: vi.fn().mockResolvedValue({ complete: true, items: [] }),
  quota: () => ({ limit: 1000, remaining: 990, reset: 60 }),
});

describe("withTracing", () => {
  it("returns the inner result unchanged", async () => {
    const traced = withTracing(stub());
    const res = await traced.search({ origin_airport: "ORD", destination_airport: "NRT" });
    expect(res.count).toBe(1);
  });

  it("calls through exactly once", async () => {
    const inner = stub();
    await withTracing(inner).search({ origin_airport: "ORD", destination_airport: "NRT" });
    expect(inner.search).toHaveBeenCalledTimes(1);
  });

  it("propagates errors rather than swallowing them", async () => {
    const inner = stub();
    (inner.search as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    await expect(
      withTracing(inner).search({ origin_airport: "ORD", destination_airport: "NRT" }),
    ).rejects.toThrow("boom");
  });

  it("leaves quota synchronous and untraced", () => {
    expect(withTracing(stub()).quota().remaining).toBe(990);
  });
});
