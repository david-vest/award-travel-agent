import { describe, it, expect } from "vitest";
import { z } from "zod";
import { summarizeTrip, makeGetTripDetailsTool, type TripSummary } from "./trip-details";
import type { Trip } from "./seats-aero/types";
import type { SeatsAeroClient } from "./seats-aero";

const trip: Trip = {
  ID: "t1",
  Stops: 0,
  Carriers: "NH",
  MileageCost: 87500,
  Cabin: "business",
  AvailabilitySegments: [
    {
      FlightNumber: "NH12",
      Carrier: "NH",
      OriginAirport: "ORD",
      DestinationAirport: "HND",
      DepartsAt: "2026-09-14T11:00:00Z",
      ArrivesAt: "2026-09-15T14:30:00Z",
      AircraftName: "Boeing 777-300ER",
    },
  ],
};

describe("summarizeTrip", () => {
  it("extracts flight numbers", () => {
    expect(summarizeTrip(trip, "avail-1").flightNumbers).toEqual(["NH12"]);
  });

  it("extracts aircraft names for cabin-review lookup", () => {
    expect(summarizeTrip(trip, "avail-1").aircraft).toEqual(["Boeing 777-300ER"]);
  });

  it("reports stop count", () => {
    expect(summarizeTrip(trip, "avail-1").stops).toBe(0);
  });

  it("carries the availabilityId through as a join key to AwardOption", () => {
    expect(summarizeTrip(trip, "avail-1").availabilityId).toBe("avail-1");
  });

  it("carries cabin and miles from the trip", () => {
    const summary = summarizeTrip(trip, "avail-1");
    expect(summary.cabin).toBe("business");
    expect(summary.miles).toBe(87500);
  });

  it("dedupes carriers across segments", () => {
    const multi: Trip = {
      ...trip,
      AvailabilitySegments: [
        ...trip.AvailabilitySegments!,
        { ...trip.AvailabilitySegments![0], FlightNumber: "NH13", Carrier: "NH" },
      ],
    };
    expect(summarizeTrip(multi, "avail-1").carriers).toEqual(["NH"]);
  });

  it("reads carriers from the trip-level Carriers field, not per-segment", () => {
    // The real API never populates AvailabilitySegments[].Carrier — only the
    // trip-level, comma-delimited Carriers string carries this data.
    const noSegmentCarrier: Trip = {
      ...trip,
      Carriers: "NH, UA",
      AvailabilitySegments: [
        { ...trip.AvailabilitySegments![0], Carrier: undefined },
      ],
    };
    expect(summarizeTrip(noSegmentCarrier, "avail-1").carriers).toEqual(["NH", "UA"]);
  });

  it("survives a trip with no segments", () => {
    const bare: Trip = { ID: "t2", Cabin: "economy", MileageCost: 45000 };
    expect(summarizeTrip(bare, "avail-2")).toMatchObject({
      availabilityId: "avail-2",
      flightNumbers: [],
      aircraft: [],
      carriers: [],
      cabin: "economy",
      miles: 45000,
    });
  });
});

describe("makeGetTripDetailsTool", () => {
  const stubClient: Pick<SeatsAeroClient, "trips"> = {
    trips: async () => ({ data: [trip] }),
  };

  it("has the exact tool name other code matches on", () => {
    const tripTool = makeGetTripDetailsTool(stubClient as SeatsAeroClient);
    expect(tripTool.name).toBe("get_trip_details");
  });

  it("requires an availabilityId string in its schema", () => {
    const tripTool = makeGetTripDetailsTool(stubClient as SeatsAeroClient);
    const schema = tripTool.schema as z.ZodObject<{ availabilityId: z.ZodString }>;
    expect(schema.parse({ availabilityId: "avail-1" })).toEqual({
      availabilityId: "avail-1",
    });
    expect(() => schema.parse({})).toThrow();
  });

  it("returns availabilityId and trip summaries as JSON", async () => {
    const tripTool = makeGetTripDetailsTool(stubClient as SeatsAeroClient);
    const result = await tripTool.invoke({ availabilityId: "avail-1" });
    const parsed = JSON.parse(result as string) as {
      availabilityId: string;
      trips: TripSummary[];
    };
    expect(parsed.availabilityId).toBe("avail-1");
    expect(parsed.trips).toEqual([summarizeTrip(trip, "avail-1")]);
  });
});
