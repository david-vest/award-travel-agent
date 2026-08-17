// src/agent/nodes/enrich.ts
import { summarizeTrip, type AwardOption, type TripSummary } from "../../tools";
import type { AgentStateType } from "../state";
import { ENRICH_TOP_N, getClient } from "./search";

/** Small enough to avoid a rate-limit burst while halving serial wait time. */
export const DETAIL_LOOKUP_CONCURRENCY = 2;

/**
 * Deterministically select the already-ranked options worth enriching. One
 * availability record can contain multiple cabins, so dedupe before applying
 * the cap; otherwise the same provider record could consume several slots.
 */
export function idsForEnrichment(
  options: AwardOption[],
  limit: number = ENRICH_TOP_N,
): string[] {
  return [...new Set(options.map((option) => option.availabilityId))].slice(0, limit);
}

/**
 * Fetch exact flight, aircraft, routing, and tax data for the top-ranked
 * records without spending an LLM round trip to make an already mechanical
 * decision. Premium-cabin and low-tax answers depend on this data, so a model
 * choosing to skip a record hurts accuracy as well as adding latency.
 */
export async function enrichTrips(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const ids = idsForEnrichment(state.awardResults ?? []);
  if (ids.length === 0) return { tripSummaries: [] };

  const client = await getClient();
  const summaries: TripSummary[] = [];
  const requestedCabins = state.searchPlan?.cabins;

  for (let start = 0; start < ids.length; start += DETAIL_LOOKUP_CONCURRENCY) {
    const batch = ids.slice(start, start + DETAIL_LOOKUP_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (id): Promise<TripSummary[]> => {
        try {
          const response = await client.trips(id);
          const trips = (response.data ?? []).map((trip) => summarizeTrip(trip, id));
          // One availabilityId can bundle trips across every cabin seats.aero
          // knows about; without this filter a business/first request gets
          // flooded with economy alternates that bury the cabins requested.
          return requestedCabins && requestedCabins.length > 0
            ? trips.filter(
                (trip) => !trip.cabin || requestedCabins.includes(trip.cabin),
              )
            : trips;
        } catch {
          return []; // enrichment is additive; one failed detail call is harmless
        }
      }),
    );
    summaries.push(...results.flat());
  }

  return { tripSummaries: summaries };
}
