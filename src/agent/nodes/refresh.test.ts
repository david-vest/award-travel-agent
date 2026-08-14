// src/agent/nodes/refresh.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AwardOption } from "../../tools";
import type { AgentStateType, SearchPlan } from "../state";
import type {
  AvailabilityResult,
  RefreshResponse,
  SearchResponse,
} from "../../tools/seats-aero/types";
import type { SeatsAeroClient } from "../../tools/seats-aero";

const searchMock = vi.fn();
const refreshMock = vi.fn();
const getClientMock = vi.fn();

/**
 * Mocks only getClient — filterByCabins/rankOptions stay real so refetch's
 * use of them is exercised for real, not just asserted by name.
 */
vi.mock("./search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./search")>();
  return {
    ...actual,
    getClient: (opts?: { skipCache?: boolean }) => getClientMock(opts),
  };
});

import { shouldRefresh, staleOptionIds, refreshAvailability, REFRESH_TOP_N } from "./refresh";

const NOW = new Date("2026-08-11T12:00:00Z");
const hoursAgo = (h: number) =>
  new Date(NOW.getTime() - h * 3_600_000).toISOString();

const opt = (over: Partial<AwardOption> = {}): AwardOption => ({
  availabilityId: "a1",
  origin: "ORD",
  destination: "NRT",
  date: "2026-09-14",
  program: "aeroplan",
  cabin: "business",
  miles: 87500,
  direct: true,
  airlines: "NH",
  updatedAt: hoursAgo(12),
  ...over,
});

const state = (over: Partial<AgentStateType> = {}): AgentStateType =>
  ({ intent: "route_search", awardResults: [opt()], ...over }) as AgentStateType;

describe("shouldRefresh", () => {
  it("refreshes a small, stale, precise result set", () => {
    expect(shouldRefresh(state(), NOW)).toBe(true);
  });

  it("never refreshes on the discovery branch, whatever the data looks like", () => {
    expect(shouldRefresh(state({ intent: "discovery" }), NOW)).toBe(false);
  });

  it("does not refresh when results are already fresh", () => {
    const fresh = state({ awardResults: [opt({ updatedAt: hoursAgo(1) })] });
    expect(shouldRefresh(fresh, NOW)).toBe(false);
  });

  it("does not refresh a large result set", () => {
    const many = state({
      awardResults: Array.from({ length: 25 }, (_, i) =>
        opt({ availabilityId: `a${i}` }),
      ),
    });
    expect(shouldRefresh(many, NOW)).toBe(false);
  });

  it("does not refresh when there are no results", () => {
    expect(shouldRefresh(state({ awardResults: [] }), NOW)).toBe(false);
  });

  it("treats a missing updatedAt as stale", () => {
    const unknown = state({ awardResults: [opt({ updatedAt: undefined })] });
    expect(shouldRefresh(unknown, NOW)).toBe(true);
  });
});

describe("staleOptionIds", () => {
  it("caps the list at the refresh top-N, because each id costs a credit", () => {
    const options = Array.from({ length: 10 }, (_, i) =>
      opt({ availabilityId: `a${i}` }),
    );
    expect(staleOptionIds(options, NOW)).toHaveLength(REFRESH_TOP_N);
  });

  it("excludes options that are already fresh", () => {
    const options = [
      opt({ availabilityId: "stale" }),
      opt({ availabilityId: "fresh", updatedAt: hoursAgo(1) }),
    ];
    expect(staleOptionIds(options, NOW)).toEqual(["stale"]);
  });

  it("dedupes repeated availability ids", () => {
    const options = [opt({ availabilityId: "x" }), opt({ availabilityId: "x" })];
    expect(staleOptionIds(options, NOW)).toEqual(["x"]);
  });

  it("returns an empty list when nothing is stale", () => {
    expect(staleOptionIds([opt({ updatedAt: hoursAgo(1) })], NOW)).toEqual([]);
  });
});

// --- refreshAvailability / refetch -----------------------------------------
//
// refreshAvailability has no `now` override, so staleness here is computed
// against the real clock — use an offset from Date.now(), not the fixed NOW
// used for shouldRefresh/staleOptionIds above.
const realHoursAgo = (h: number) =>
  new Date(Date.now() - h * 3_600_000).toISOString();

function fakeClient(overrides: Partial<SeatsAeroClient> = {}): SeatsAeroClient {
  return {
    search: searchMock,
    regionalAvailability: vi.fn(),
    trips: vi.fn(),
    routes: vi.fn(),
    refresh: refreshMock,
    quota: () => ({ limit: 1000, remaining: 999, reset: 60 }),
    ...overrides,
  };
}

/** A record with BOTH economy and business available — same shape that
 * exposed the Phase-4 cabin leak (search.test.ts's multiCabinRecord). */
function multiCabinRecord(over: Partial<AvailabilityResult> = {}): AvailabilityResult {
  return {
    ID: "rec1",
    RouteID: "r1",
    Route: {
      ID: "r1",
      OriginAirport: "ORD",
      DestinationAirport: "LHR",
      Distance: 4000,
      Source: "aeroplan",
    },
    Date: "2026-09-14",
    ParsedDate: "2026-09-14",
    Source: "aeroplan",
    YAvailable: true,
    WAvailable: false,
    JAvailable: true,
    FAvailable: false,
    YMileageCost: "50000",
    WMileageCost: "0",
    JMileageCost: "120000",
    FMileageCost: "0",
    YDirect: true,
    WDirect: false,
    JDirect: true,
    FDirect: false,
    Airlines: "UA",
    UpdatedAt: new Date().toISOString(),
    ...over,
  };
}

const searchResponse = (data: AvailabilityResult[]): SearchResponse => ({
  data,
  count: data.length,
  hasMore: false,
  cursor: 0,
});

const succeeded = (ids: string[]): RefreshResponse => ({
  complete: true,
  items: ids.map((id) => ({ id, status: "succeeded" as const })),
});

const plan: SearchPlan = {
  origins: ["ORD"],
  destinations: ["LHR"],
  cabins: ["business"],
  nonstopOnly: false,
  programs: [],
};

const routeState = (over: Partial<AgentStateType> = {}): AgentStateType =>
  ({
    intent: "route_search",
    searchPlan: plan,
    awardResults: [],
    ...over,
  }) as AgentStateType;

describe("refreshAvailability / refetch", () => {
  beforeEach(() => {
    searchMock.mockReset();
    refreshMock.mockReset();
    getClientMock.mockReset();
    getClientMock.mockImplementation(() => Promise.resolve(fakeClient()));
  });

  it("[Fix2] does not reintroduce the cabin leak — only the plan's cabins survive refetch", async () => {
    const previous = [
      opt({ availabilityId: "rec1", cabin: "business", updatedAt: realHoursAgo(12) }),
    ];
    refreshMock.mockResolvedValueOnce(succeeded(["rec1"]));
    searchMock.mockResolvedValueOnce(searchResponse([multiCabinRecord()]));

    const result = await refreshAvailability(routeState({ awardResults: previous }));

    // A business-only plan must not gain the economy option the same record
    // (same availabilityId, different cabin) carries.
    expect(result.awardResults).toBeDefined();
    expect(result.awardResults!.every((o) => o.cabin === "business")).toBe(true);
  });

  it("[Fix3] re-ranks refetch's output cheapest-first instead of returning search order", async () => {
    const previous = [
      opt({ availabilityId: "pricey", cabin: "business", miles: 200_000, updatedAt: realHoursAgo(12) }),
      opt({ availabilityId: "cheap", cabin: "business", miles: 90_000, updatedAt: realHoursAgo(12) }),
    ];
    refreshMock.mockResolvedValueOnce(succeeded(["pricey", "cheap"]));
    // Response deliberately returns the pricier record first — if refetch
    // didn't re-rank, the pricey option would stay first in the output.
    searchMock.mockResolvedValueOnce(
      searchResponse([
        multiCabinRecord({
          ID: "pricey",
          RouteID: "r-pricey",
          YAvailable: false,
          JMileageCost: "200000",
        }),
        multiCabinRecord({
          ID: "cheap",
          RouteID: "r-cheap",
          YAvailable: false,
          JMileageCost: "90000",
        }),
      ]),
    );

    const result = await refreshAvailability(routeState({ awardResults: previous }));

    expect(result.awardResults?.[0].availabilityId).toBe("cheap");
  });

  it("[Fix1] refetch reaches a genuinely uncached client instead of replaying the response cache", async () => {
    const previous = [
      opt({ availabilityId: "rec1", cabin: "business", updatedAt: realHoursAgo(12) }),
    ];
    refreshMock.mockResolvedValueOnce(succeeded(["rec1"]));

    // Simulate the bug directly: a client obtained WITHOUT skipCache replays
    // a stale cached payload; only skipCache:true reaches "live" data. If
    // refetch() calls bare getClient() (the pre-fix bug), it gets the stale
    // sentinel below instead of the live value.
    const staleCachedSearch = vi.fn().mockResolvedValue(
      searchResponse([multiCabinRecord({ JMileageCost: "999999" })]),
    );
    const liveSearch = vi.fn().mockResolvedValue(
      searchResponse([multiCabinRecord({ JMileageCost: "120000" })]),
    );
    getClientMock.mockImplementation((opts?: { skipCache?: boolean }) =>
      Promise.resolve(
        fakeClient({
          search: opts?.skipCache ? liveSearch : staleCachedSearch,
        }),
      ),
    );

    const result = await refreshAvailability(routeState({ awardResults: previous }));

    expect(result.awardResults?.[0].miles).toBe(120_000);
    expect(liveSearch).toHaveBeenCalledTimes(1);
    expect(staleCachedSearch).not.toHaveBeenCalled();
  });

  it("returns no update when nothing is stale", async () => {
    const fresh = [opt({ updatedAt: realHoursAgo(1) })];

    const result = await refreshAvailability(routeState({ awardResults: fresh }));

    expect(result).toEqual({});
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("confirms freshness without calling search when every item is already fresh", async () => {
    const previous = [opt({ availabilityId: "rec1", updatedAt: realHoursAgo(12) })];
    refreshMock.mockResolvedValueOnce({
      complete: true,
      items: [{ id: "rec1", status: "fresh" }],
    });

    const result = await refreshAvailability(routeState({ awardResults: previous }));

    expect(result.refreshedAt).toBeTruthy();
    expect(searchMock).not.toHaveBeenCalled();
  });
});
