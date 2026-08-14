// src/agent/nodes/search.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AwardOption } from "../../tools";
import type { AvailabilityResult, SearchResponse } from "../../tools/seats-aero/types";
import type { AgentStateType, SearchPlan } from "../state";

const opt = (over: Partial<AwardOption>): AwardOption => ({
  availabilityId: "a",
  origin: "ORD",
  destination: "NRT",
  date: "2026-09-14",
  program: "aeroplan",
  cabin: "business",
  miles: 100_000,
  direct: false,
  airlines: "NH",
  ...over,
});

const searchMock = vi.fn();
const regionalAvailabilityMock = vi.fn();

vi.mock("../../tools/seats-aero", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../tools/seats-aero")>();
  return {
    ...actual,
    createSeatsAeroClient: () => ({
      search: searchMock,
      regionalAvailability: regionalAvailabilityMock,
      trips: vi.fn(),
      routes: vi.fn(),
      refresh: vi.fn(),
      quota: () => ({ limit: 1000, remaining: 999, reset: 60 }),
    }),
  };
});

vi.mock("../../rag/store", () => ({
  mongoClient: vi.fn().mockRejectedValue(new Error("no mongo in tests")),
  DB_NAME: "test",
}));

import {
  searchAwards,
  filterByCabins,
  regionForOrigin,
  rankOptions,
  ENRICH_TOP_N,
} from "./search";

/** A record with BOTH economy and business available — the exact shape that
 * exposed the bug: seats.aero packs all cabins into one record, and a record
 * qualifies for the server-side cabin filter if ANY requested cabin matches. */
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
    UpdatedAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}

const searchResponse = (data: AvailabilityResult[]): SearchResponse => ({
  data,
  count: data.length,
  hasMore: false,
  cursor: 0,
});

describe("rankOptions", () => {
  it("puts cheaper options first", () => {
    const r = rankOptions([opt({ miles: 200_000 }), opt({ miles: 90_000 })]);
    expect(r[0].miles).toBe(90_000);
  });

  it("prefers a nonstop over a connection at equal price", () => {
    const r = rankOptions([
      opt({ miles: 90_000, direct: false, availabilityId: "conn" }),
      opt({ miles: 90_000, direct: true, availabilityId: "nonstop" }),
    ]);
    expect(r[0].availabilityId).toBe("nonstop");
  });

  it("does not prefer a nonstop that costs dramatically more", () => {
    const r = rankOptions([
      opt({ miles: 300_000, direct: true, availabilityId: "pricey" }),
      opt({ miles: 90_000, direct: false, availabilityId: "cheap" }),
    ]);
    expect(r[0].availabilityId).toBe("cheap");
  });

  it("is stable for identical options", () => {
    const a = opt({ availabilityId: "1" });
    const b = opt({ availabilityId: "2" });
    expect(rankOptions([a, b]).map((o) => o.availabilityId)).toEqual(["1", "2"]);
  });

  it("handles an empty list", () => {
    expect(rankOptions([])).toEqual([]);
  });

  it("enriches exactly five options", () => {
    expect(ENRICH_TOP_N).toBe(5);
  });
});

describe("filterByCabins", () => {
  it("drops options whose cabin was not requested", () => {
    const options = [opt({ cabin: "economy" }), opt({ cabin: "business" })];
    expect(filterByCabins(options, ["business"])).toEqual([opt({ cabin: "business" })]);
  });

  it("treats an empty cabins list as no filter", () => {
    const options = [opt({ cabin: "economy" }), opt({ cabin: "business" })];
    expect(filterByCabins(options, [])).toEqual(options);
  });
});

describe("regionForOrigin", () => {
  it("derives the real region for a known origin", () => {
    expect(regionForOrigin("LHR")).toBe("Europe");
    expect(regionForOrigin("NRT")).toBe("Asia");
  });

  it("falls back to North America when the origin can't be resolved", () => {
    expect(regionForOrigin("ZZZ")).toBe("North America");
    expect(regionForOrigin(undefined)).toBe("North America");
  });
});

describe("searchAwards", () => {
  beforeEach(() => {
    searchMock.mockReset();
    regionalAvailabilityMock.mockReset();
  });

  const basePlan: SearchPlan = {
    origins: ["ORD"],
    destinations: ["LHR"],
    cabins: [],
    nonstopOnly: false,
    programs: [],
  };

  it("[BUG-CABIN-FILTER] filters direct-branch results to only the requested cabin", async () => {
    searchMock.mockResolvedValueOnce(searchResponse([multiCabinRecord()]));

    const state = {
      searchPlan: { ...basePlan, cabins: ["business"] },
      intent: "route_search",
    } as unknown as AgentStateType;

    const result = await searchAwards(state);

    expect(result.awardResults).toHaveLength(1);
    expect(result.awardResults?.every((o) => o.cabin === "business")).toBe(true);
  });

  it("keeps every cabin on the direct branch when cabins is empty", async () => {
    searchMock.mockResolvedValueOnce(searchResponse([multiCabinRecord()]));

    const state = {
      searchPlan: { ...basePlan, cabins: [] },
      intent: "route_search",
    } as unknown as AgentStateType;

    const result = await searchAwards(state);

    expect(result.awardResults).toHaveLength(2);
  });

  it("[BUG-CABIN-FILTER] filters discovery-branch results by each probe's own cabin, not the plan's flattened union", async () => {
    regionalAvailabilityMock.mockResolvedValueOnce(searchResponse([multiCabinRecord()]));

    const plan: SearchPlan = {
      origins: ["ORD"],
      destinations: [],
      // Flattened union spans both cabins — the bug this guards against is
      // filtering by this union instead of the probe's own cabin.
      cabins: ["economy", "business"],
      nonstopOnly: false,
      programs: ["aeroplan"],
      discoveryProbes: [{ program: "aeroplan", destinationRegion: "Europe", cabin: "business" }],
    };
    const state = { searchPlan: plan, intent: "discovery" } as unknown as AgentStateType;

    const result = await searchAwards(state);

    expect(result.awardResults).toHaveLength(1);
    expect(result.awardResults?.[0].cabin).toBe("business");
  });

  it("[BUG-ORIGIN-REGION] derives origin_region from the plan's actual origin, not a hardcoded North America", async () => {
    regionalAvailabilityMock.mockResolvedValueOnce(searchResponse([]));

    const plan: SearchPlan = {
      origins: ["LHR"],
      destinations: [],
      cabins: ["business"],
      nonstopOnly: false,
      programs: ["aeroplan"],
      discoveryProbes: [{ program: "aeroplan", destinationRegion: "Asia", cabin: "business" }],
    };
    const state = { searchPlan: plan, intent: "discovery" } as unknown as AgentStateType;

    await searchAwards(state);

    expect(regionalAvailabilityMock).toHaveBeenCalledWith(
      expect.objectContaining({ origin_region: "Europe" }),
    );
  });

  it("[BUG-ORIGIN-REGION] short-circuits the discovery branch with no origins instead of burning probes", async () => {
    const plan: SearchPlan = {
      origins: [],
      destinations: [],
      cabins: ["business"],
      nonstopOnly: false,
      programs: ["aeroplan"],
      discoveryProbes: [{ program: "aeroplan", destinationRegion: "Europe", cabin: "business" }],
    };
    const state = { searchPlan: plan, intent: "discovery" } as unknown as AgentStateType;

    const result = await searchAwards(state);

    expect(result.awardResults).toEqual([]);
    expect(regionalAvailabilityMock).not.toHaveBeenCalled();
  });
});
