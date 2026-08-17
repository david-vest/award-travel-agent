import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { SeatsAeroClient } from "./seats-aero";
import type { Trip } from "./seats-aero/types";
import { normalizeTaxes } from "./seats-aero/money";

export type TripSummary = {
  availabilityId: string;
  tripId: string;
  flightNumbers: string[];
  aircraft: string[];
  carriers: string[];
  stops: number;
  durationMinutes?: number;
  connections?: Array<{ airport: string; layoverMinutes?: number }>;
  cabin?: string;
  miles?: number;
  totalTaxes?: number;
  taxesCurrency?: string;
  remainingSeats?: number;
  departsAt?: string;
  arrivesAt?: string;
};

function connectionDetails(trip: Trip): Array<{ airport: string; layoverMinutes?: number }> {
  const segments = trip.AvailabilitySegments ?? [];
  if (segments.length > 1) {
    return segments.slice(0, -1).map((segment, index) => {
      const next = segments[index + 1];
      const arrival = Date.parse(segment.ArrivesAt);
      const departure = Date.parse(next.DepartsAt);
      const layoverMinutes = Number.isFinite(arrival) && Number.isFinite(departure)
        ? Math.max(0, Math.round((departure - arrival) / 60_000))
        : undefined;
      return { airport: segment.DestinationAirport, layoverMinutes };
    });
  }
  return (trip.Connections ?? []).map((airport) => ({ airport }));
}

const uniq = (xs: (string | undefined)[]): string[] =>
  [...new Set(xs.filter((x): x is string => Boolean(x)))];

/**
 * Aircraft type is why this call exists: it is intended as the join key into
 * the cabin product reviews in the knowledge base (a later retrieval step) —
 * "ANA 777-300ER" and "Lufthansa A340" are very different seats at the same
 * price. Not wired up yet.
 */
export function summarizeTrip(trip: Trip, availabilityId: string): TripSummary {
  const segments = trip.AvailabilitySegments ?? [];
  return {
    availabilityId,
    tripId: trip.ID,
    flightNumbers: uniq(segments.map((s) => s.FlightNumber)),
    aircraft: uniq([...segments.map((s) => s.AircraftName), ...(trip.Aircraft ?? [])]),
    // Per-segment `Carrier` isn't populated by the real API; the trip-level
    // `Carriers` field (comma-delimited) is the one that actually carries data.
    carriers: uniq((trip.Carriers ?? "").split(",").map((c) => c.trim())),
    stops: trip.Stops ?? Math.max(0, segments.length - 1),
    durationMinutes: trip.TotalDuration,
    connections: connectionDetails(trip),
    cabin: trip.Cabin,
    miles: trip.MileageCost,
    totalTaxes: normalizeTaxes(trip.TotalTaxes, trip.TaxesCurrency),
    taxesCurrency: trip.TaxesCurrency,
    remainingSeats: trip.RemainingSeats,
    departsAt: trip.DepartsAt ?? segments[0]?.DepartsAt,
    arrivesAt: trip.ArrivesAt ?? segments[segments.length - 1]?.ArrivesAt,
  };
}

/**
 * The one tool a model actually calls in this codebase. Safe to delegate
 * specifically because Task 4.6 only ever offers it against an already
 * hard-capped candidate list — see this task's design note.
 */
export function makeGetTripDetailsTool(client: SeatsAeroClient) {
  return tool(
    async ({ availabilityId }: { availabilityId: string }): Promise<string> => {
      const res = await client.trips(availabilityId);
      return JSON.stringify({
        availabilityId,
        trips: (res.data ?? []).map((t) => summarizeTrip(t, availabilityId)),
      });
    },
    {
      name: "get_trip_details",
      description:
        "Fetch flight-level detail (flight numbers, aircraft type, timings) for " +
        "one availability record. Call this for options worth verifying before " +
        "recommending — aircraft type determines which cabin product the " +
        "traveler actually gets, and it's cheap to check when it matters.",
      schema: z.object({
        availabilityId: z
          .string()
          .describe("The availabilityId from a search result"),
      }),
    },
  );
}
