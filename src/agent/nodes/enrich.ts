// src/agent/nodes/enrich.ts
import { makeGetTripDetailsTool, type TripSummary } from "../../tools";
import type { AgentStateType } from "../state";
import { getClient } from "./search";

/** How many ranked results get full trip detail (connections, schedule, duration, flight numbers, taxes). */
export const ENRICH_DISPLAY_CAP = 20;

/** Small enough to avoid a rate-limit burst while still fetching everything quickly. */
const BACKFILL_CONCURRENCY = 3;

/**
 * Deterministic, bounded trip-detail lookup for every displayed option — no
 * model call involved. A model-selected shortlist was tried here previously,
 * but every displayed option was backfilled deterministically regardless of
 * what the model picked, so the model's choice never actually changed the
 * outcome; it only added latency and cost, and its own failure path skipped
 * the backfill entirely rather than falling through to it.
 */
export async function enrichTrips(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const displayed = (state.awardResults ?? []).slice(0, ENRICH_DISPLAY_CAP);
  if (displayed.length === 0) return { tripSummaries: [] };

  const client = await getClient();
  const tripsTool = makeGetTripDetailsTool(client);
  const summaries: TripSummary[] = [];
  const requestedCabins = state.searchPlan?.cabins;

  async function lookup(availabilityId: string): Promise<void> {
    try {
      const raw = await tripsTool.invoke({ availabilityId });
      const parsed = JSON.parse(raw) as { trips?: TripSummary[] };
      const trips = parsed.trips ?? [];
      // One availabilityId can bundle trips across every cabin seats.aero
      // knows about; without this filter a business/first request gets
      // flooded with economy alternates that bury the cabins actually asked
      // for and burn context on options the user can't use.
      const relevant =
        requestedCabins && requestedCabins.length > 0
          ? trips.filter((t) => !t.cabin || requestedCabins.includes(t.cabin))
          : trips;
      summaries.push(...relevant);
    } catch {
      // enrichment is additive; one failed lookup must not fail the turn
    }
  }

  // Bounded batches so the burst doesn't trip the provider's rate limiter.
  for (let start = 0; start < displayed.length; start += BACKFILL_CONCURRENCY) {
    const batch = displayed.slice(start, start + BACKFILL_CONCURRENCY);
    await Promise.all(batch.map((o) => lookup(o.availabilityId)));
  }

  const merged = new Map((state.tripSummaries ?? []).map((summary) => [`${summary.availabilityId}:${summary.tripId}`, summary]));
  for (const summary of summaries) merged.set(`${summary.availabilityId}:${summary.tripId}`, summary);
  return { tripSummaries: [...merged.values()] };
}
