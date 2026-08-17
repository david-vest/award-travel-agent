import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AwardOption } from "../../tools";
import type { SeatsAeroClient } from "../../tools/seats-aero";
import type { Trip } from "../../tools/seats-aero/types";
import type { AgentStateType } from "../state";

const getClientMock = vi.fn();

vi.mock("./search", () => ({
  getClient: () => getClientMock(),
  ENRICH_TOP_N: 5,
}));

import {
  DETAIL_LOOKUP_CONCURRENCY,
  enrichTrips,
  idsForEnrichment,
} from "./enrich";

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
  ...over,
});

const trip = (over: Partial<Trip> = {}): Trip => ({
  ID: "t1",
  Cabin: "business",
  MileageCost: 87500,
  TotalTaxes: 7340,
  TaxesCurrency: "USD",
  Stops: 0,
  Carriers: "NH",
  AvailabilitySegments: [
    {
      FlightNumber: "NH12",
      OriginAirport: "ORD",
      DestinationAirport: "HND",
      DepartsAt: "2026-09-14T11:00:00Z",
      ArrivesAt: "2026-09-15T14:30:00Z",
      AircraftName: "Boeing 777-300ER",
    },
  ],
  ...over,
});

function clientWithTrips(
  trips: SeatsAeroClient["trips"],
): Pick<SeatsAeroClient, "trips"> {
  return { trips };
}

describe("idsForEnrichment", () => {
  it("keeps ranked order while deduping availability records", () => {
    expect(
      idsForEnrichment([
        opt({ availabilityId: "a1", cabin: "business" }),
        opt({ availabilityId: "a1", cabin: "first" }),
        opt({ availabilityId: "a2" }),
      ]),
    ).toEqual(["a1", "a2"]);
  });

  it("caps detail lookups at the enrichment budget", () => {
    const options = Array.from({ length: 8 }, (_, index) =>
      opt({ availabilityId: `a${index}` }),
    );
    expect(idsForEnrichment(options)).toHaveLength(5);
  });
});

describe("enrichTrips", () => {
  beforeEach(() => {
    getClientMock.mockReset();
  });

  it("returns immediately when no flight options exist", async () => {
    const result = await enrichTrips({
      awardResults: [],
    } as unknown as AgentStateType);
    expect(result).toEqual({ tripSummaries: [] });
    expect(getClientMock).not.toHaveBeenCalled();
  });

  it("deterministically fetches exact details for the ranked options", async () => {
    const trips = vi.fn(async (id: string) => ({
      data: [trip({ ID: `trip-${id}` })],
    }));
    getClientMock.mockResolvedValue(clientWithTrips(trips));

    const result = await enrichTrips({
      awardResults: [
        opt({ availabilityId: "a1" }),
        opt({ availabilityId: "a2" }),
      ],
      searchPlan: { cabins: ["business"] },
    } as AgentStateType);

    expect(trips).toHaveBeenCalledTimes(2);
    expect(result.tripSummaries).toHaveLength(2);
    expect(result.tripSummaries?.[0]).toMatchObject({
      availabilityId: "a1",
      taxes: 73.4,
      taxesCurrency: "USD",
      flightNumbers: ["NH12"],
    });
  });

  it("drops trips outside the requested cabins", async () => {
    getClientMock.mockResolvedValue(
      clientWithTrips(async () => ({
        data: [
          trip({ ID: "economy", Cabin: "economy" }),
          trip({ ID: "first", Cabin: "first" }),
          trip({ ID: "unknown", Cabin: undefined }),
        ],
      })),
    );

    const result = await enrichTrips({
      awardResults: [opt()],
      searchPlan: { cabins: ["business", "first"] },
    } as AgentStateType);

    expect(result.tripSummaries?.map((summary) => summary.tripId)).toEqual([
      "first",
      "unknown",
    ]);
  });

  it("continues when one detail lookup fails", async () => {
    getClientMock.mockResolvedValue(
      clientWithTrips(async (id) => {
        if (id === "a1") throw new Error("temporary provider failure");
        return { data: [trip({ ID: "working" })] };
      }),
    );

    const result = await enrichTrips({
      awardResults: [
        opt({ availabilityId: "a1" }),
        opt({ availabilityId: "a2" }),
      ],
    } as AgentStateType);

    expect(result.tripSummaries?.map((summary) => summary.tripId)).toEqual([
      "working",
    ]);
  });

  it("limits concurrent provider calls to two", async () => {
    let active = 0;
    let maxActive = 0;
    getClientMock.mockResolvedValue(
      clientWithTrips(async (id) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { data: [trip({ ID: `trip-${id}` })] };
      }),
    );

    await enrichTrips({
      awardResults: Array.from({ length: 5 }, (_, index) =>
        opt({ availabilityId: `a${index}` }),
      ),
    } as AgentStateType);

    expect(DETAIL_LOOKUP_CONCURRENCY).toBe(2);
    expect(maxActive).toBe(2);
  });
});
