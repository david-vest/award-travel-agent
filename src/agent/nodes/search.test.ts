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
  destinationsForSearch,
  filterByCabins,
  filterByPointBalances,
  regionForOrigin,
  rankOptions,
  prefersLowTaxes,
  ENRICH_TOP_N,
  MAX_ROUTE_SEARCH_CALLS,
  buildPositioningAttempts,
  needsPositioningSearch,
  searchPositioningOptions,
} from "./search";

describe("filterByPointBalances", () => {
  it("uses the total trip cost and treats missing program balances as zero", () => {
    const plan = {
      origins: ["ORD"], destinations: ["NRT"], cabins: ["business"], nonstopOnly: false,
      programs: [], travelers: 2, filterByPointBalances: true,
      availablePointsByProgram: { aeroplan: 180_000 },
    } satisfies SearchPlan;
    const filtered = filterByPointBalances([
      opt({ availabilityId: "within", miles: 90_000 }),
      opt({ availabilityId: "over", miles: 90_001 }),
      opt({ availabilityId: "unknown", program: "united", miles: 50_000 }),
    ], plan);
    expect(filtered.map((item) => item.availabilityId)).toEqual(["within"]);
  });
});

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

  it("puts lower same-currency taxes first when the user prioritizes fees", () => {
    const r = rankOptions(
      [
        opt({
          availabilityId: "cheap-miles",
          miles: 60_000,
          taxes: 1454,
          taxesCurrency: "USD",
        }),
        opt({
          availabilityId: "low-fees",
          miles: 62_500,
          taxes: 112.9,
          taxesCurrency: "USD",
        }),
      ],
      { preferLowTaxes: true },
    );
    expect(r[0].availabilityId).toBe("low-fees");
  });

  it("puts reported taxes before options whose taxes are unknown", () => {
    const r = rankOptions(
      [
        opt({ availabilityId: "unknown", miles: 50_000 }),
        opt({
          availabilityId: "known",
          miles: 70_000,
          taxes: 150,
          taxesCurrency: "USD",
        }),
      ],
      { preferLowTaxes: true },
    );
    expect(r[0].availabilityId).toBe("known");
  });

  it("does not compare tax amounts across unlike currencies", () => {
    const r = rankOptions(
      [
        opt({
          availabilityId: "cad",
          miles: 80_000,
          taxes: 100,
          taxesCurrency: "CAD",
        }),
        opt({
          availabilityId: "usd",
          miles: 60_000,
          taxes: 90,
          taxesCurrency: "USD",
        }),
      ],
      { preferLowTaxes: true },
    );
    expect(r[0].availabilityId).toBe("usd");
  });

  it("enriches exactly five options", () => {
    expect(ENRICH_TOP_N).toBe(5);
  });
});

describe("prefersLowTaxes", () => {
  it.each([
    "business class with low taxes",
    "minimize fees",
    "avoid carrier surcharges",
    "taxes are lowest",
  ])("recognizes %s", (text) => {
    expect(prefersLowTaxes(text)).toBe(true);
  });

  it("does not treat an ordinary query as tax-prioritized", () => {
    expect(prefersLowTaxes("business flights from USA to Europe")).toBe(false);
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

  it("derives the region for seats.aero multi-city codes", () => {
    expect(regionForOrigin("USA")).toBe("North America");
    expect(regionForOrigin("EUR")).toBe("Europe");
  });

  it("falls back to North America when the origin can't be resolved", () => {
    expect(regionForOrigin("ZZZ")).toBe("North America");
    expect(regionForOrigin(undefined)).toBe("North America");
  });
});

describe("destinationsForSearch", () => {
  it("uses seats.aero's EUR code for a broad Europe route", () => {
    expect(destinationsForSearch([], "Europe")).toEqual(["EUR"]);
  });

  it("does not narrow North America to the USA country grouping", () => {
    expect(destinationsForSearch([], "North America")).toEqual([]);
  });

  it("keeps concrete destinations ahead of a broad region", () => {
    expect(destinationsForSearch(["CDG", "LHR"], "Europe")).toEqual([
      "CDG",
      "LHR",
    ]);
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

  it("passes the USD fee ceiling in cents and removes awards above entered balances", async () => {
    searchMock.mockResolvedValueOnce(searchResponse([multiCabinRecord({ JMileageCost: "90000" })]));
    const state = {
      searchPlan: {
        ...basePlan,
        cabins: ["business"],
        travelers: 2,
        filterByPointBalances: true,
        availablePointsByProgram: { aeroplan: 170_000 },
        maxTaxesFeesUsd: 125,
      },
      intent: "route_search",
    } as unknown as AgentStateType;

    const result = await searchAwards(state);

    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({ max_fees: 12_500 }));
    expect(result.awardResults).toEqual([]);
  });

  it("searches USA to EUR across every program in one call when no program was requested", async () => {
    searchMock.mockResolvedValueOnce(searchResponse([multiCabinRecord()]));

    const plan: SearchPlan = {
      origins: ["USA"],
      destinations: [],
      destinationRegion: "Europe",
      cabins: ["business"],
      nonstopOnly: false,
      programs: [],
    };
    const result = await searchAwards({
      searchPlan: plan,
      intent: "route_search",
    } as AgentStateType);

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        origin_airport: "USA",
        destination_airport: "EUR",
        sources: undefined,
      }),
    );
    expect(result.awardResults).toHaveLength(1);
    expect(result.searchStatus).toBe("searched");
    expect(result.searchAttempts).toHaveLength(1);
  });

  it("sends several origins and destinations in one comma-delimited API call", async () => {
    searchMock.mockResolvedValueOnce(searchResponse([]));

    await searchAwards({
      searchPlan: {
        ...basePlan,
        origins: ["CAL", "NYC"],
        destinations: ["LON", "PAR", "SCH"],
      },
      intent: "route_search",
    } as AgentStateType);

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        origin_airport: "CAL,NYC",
        destination_airport: "LON,PAR,SCH",
      }),
    );
  });

  it("honors an explicit mileage-program constraint without broadening it", async () => {
    searchMock.mockResolvedValueOnce(searchResponse([]));

    const result = await searchAwards({
      searchPlan: {
        ...basePlan,
        programs: ["aeroplan", "lifemiles"],
      },
      intent: "route_search",
    } as AgentStateType);

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({ sources: "aeroplan,lifemiles" }),
    );
    expect(result.awardResults).toEqual([]);
    expect(result.searchStatus).toBe("searched");
  });

  it("does not send unsupported program identifiers to seats.aero", async () => {
    searchMock.mockResolvedValueOnce(searchResponse([]));

    await searchAwards({
      searchPlan: {
        ...basePlan,
        programs: ["avianca"],
      },
      intent: "route_search",
    } as AgentStateType);

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({ sources: undefined }),
    );
  });

  it("distinguishes provider failure from a successful empty search", async () => {
    searchMock.mockRejectedValue(new Error("provider unavailable"));

    const result = await searchAwards({
      searchPlan: { ...basePlan, programs: ["aeroplan"] },
      intent: "route_search",
    } as AgentStateType);

    expect(result.awardResults).toEqual([]);
    expect(result.searchStatus).toBe("provider_error");
    expect(result.searchAttempts).toHaveLength(1);
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
    expect(result.searchStatus).toBe("not_run");
    expect(regionalAvailabilityMock).not.toHaveBeenCalled();
  });
});

describe("bounded positioning fallback", () => {
  const fukuokaPlan: SearchPlan = {
    origins: ["ORD"],
    destinations: ["FUK"],
    cabins: ["business"],
    nonstopOnly: false,
    stopPreference: "up_to_one",
    programs: [],
    travelers: 1,
  };

  beforeEach(() => searchMock.mockReset());

  it("builds the expected Chicago-to-Fukuoka broadening ladder", () => {
    expect(buildPositioningAttempts(fukuokaPlan)).toEqual([
      expect.objectContaining({ tier: "destination_gateway", origins: ["ORD"], destinations: ["TYO", "JPN"] }),
      expect.objectContaining({ tier: "country_pair", origins: ["USA"], destinations: ["JPN"] }),
      expect.objectContaining({ tier: "region_pair", origins: ["USA"], destinations: ["ASA"] }),
    ]);
  });

  it("uses the published Germany group instead of the stale legacy code", () => {
    expect(buildPositioningAttempts({ ...fukuokaPlan, destinations: ["FRA"] })).toEqual([
      expect.objectContaining({ tier: "destination_gateway", destinations: ["GCR"] }),
      expect.objectContaining({ tier: "country_pair", origins: ["USA"], destinations: ["GCR"] }),
      expect.objectContaining({ tier: "region_pair", origins: ["USA"], destinations: ["EUR"] }),
    ]);
  });

  it("never exceeds four total route-search calls", async () => {
    searchMock.mockResolvedValue(searchResponse([]));
    const result = await searchPositioningOptions({
      intent: "route_search",
      searchPlan: fukuokaPlan,
      awardResults: [],
      searchAttempts: [{ tier: "exact", origins: ["ORD"], destinations: ["FUK"], reason: "Exact", resultCount: 0 }],
    } as unknown as AgentStateType);

    expect(searchMock).toHaveBeenCalledTimes(MAX_ROUTE_SEARCH_CALLS - 1);
    expect(result.searchAttempts).toHaveLength(MAX_ROUTE_SEARCH_CALLS);
    expect(result.positioningSearchComplete).toBe(true);
  });

  it("stops broadening once a fallback returns several reasonable options", async () => {
    searchMock.mockResolvedValueOnce(searchResponse([
      multiCabinRecord({ ID: "one", JMileageCost: "70000" }),
      multiCabinRecord({ ID: "two", JMileageCost: "80000" }),
      multiCabinRecord({ ID: "three", JMileageCost: "90000" }),
    ]));
    await searchPositioningOptions({
      intent: "route_search", searchPlan: fukuokaPlan, awardResults: [],
      searchAttempts: [{ tier: "exact", origins: ["ORD"], destinations: ["FUK"], reason: "Exact", resultCount: 0 }],
    } as unknown as AgentStateType);
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  it("broadens when exact options are expensive, high-fee, or insufficiently verified", () => {
    const baseState = { intent: "route_search", searchPlan: fukuokaPlan, positioningSearchComplete: false };
    expect(needsPositioningSearch({ ...baseState, awardResults: [] } as unknown as AgentStateType)).toBe(true);
    expect(needsPositioningSearch({ ...baseState, awardResults: [opt({ miles: 220_000 })], tripSummaries: [] } as unknown as AgentStateType)).toBe(true);
    expect(needsPositioningSearch({
      ...baseState,
      awardResults: [opt({ miles: 80_000 })],
      tripSummaries: [{ availabilityId: "a", tripId: "t", flightNumbers: [], aircraft: [], carriers: [], stops: 1, totalTaxes: 900, taxesCurrency: "USD", durationMinutes: 900 }],
    } as unknown as AgentStateType)).toBe(true);
  });
});
