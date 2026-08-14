// src/agent/nodes/search.ts
import {
  createSeatsAeroClient,
  type SeatsAeroClient,
} from "../../tools/seats-aero";
import {
  mongoCacheStore,
  withResponseCache,
} from "../../tools/seats-aero/response-cache";
import { withTracing } from "../../tools/seats-aero/traced";
import { normalizeResults, type AwardOption } from "../../tools";
import { mongoClient, DB_NAME } from "../../rag/store";
import { probesFromPlan } from "./plan-discovery";
import { AIRPORTS } from "../../tools/locations/data";
import type { Region } from "../../tools/seats-aero/types";
import type { AgentStateType } from "../state";

export const ENRICH_TOP_N = 5;

let clientPromise: Promise<SeatsAeroClient> | undefined;

/** Memoized so the TTL index is created once, not per request. */
export function getClient(): Promise<SeatsAeroClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const inner = createSeatsAeroClient();
      try {
        const db = (await mongoClient()).db(DB_NAME);
        return withTracing(withResponseCache(inner, await mongoCacheStore(db)));
      } catch {
        // Mongo unavailable — run uncached rather than failing the turn.
        return withTracing(inner);
      }
    })();
  }
  return clientPromise;
}

/**
 * Cheapest first, with a nonstop preference expressed as a mileage discount
 * rather than a hard sort key — so a nonstop wins a tie but not a 3x premium.
 */
export function rankOptions(options: AwardOption[]): AwardOption[] {
  const NONSTOP_BONUS = 0.9;
  return [...options].sort(
    (a, b) =>
      a.miles * (a.direct ? NONSTOP_BONUS : 1) -
      b.miles * (b.direct ? NONSTOP_BONUS : 1),
  );
}

/**
 * Filters flattened AwardOptions down to the requested cabins. `normalizeResults`
 * expands every available cabin on a record regardless of what was asked for —
 * seats.aero's server-side cabin filter only requires ANY requested cabin to
 * qualify a record, not that every returned cabin was requested — so this
 * filter is what actually enforces "business only" etc. An empty `cabins`
 * list means "no filter", not "exclude everything".
 */
export function filterByCabins(
  options: AwardOption[],
  cabins: string[],
): AwardOption[] {
  if (cabins.length === 0) return options;
  return options.filter((o) => cabins.includes(o.cabin));
}

/**
 * Looks up the seats.aero region for an origin IATA code from the airport
 * table. Falls back to North America only when the origin genuinely can't be
 * resolved — this should not normally trigger.
 */
export function regionForOrigin(iata: string | undefined): Region {
  const found = iata ? AIRPORTS.find((a) => a.iata === iata) : undefined;
  return found ? found.region : "North America";
}

export async function searchAwards(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const plan = state.searchPlan;
  if (!plan) return { awardResults: [] };

  const client = await getClient();
  const collected: AwardOption[] = [];

  if (state.intent === "discovery") {
    if (plan.origins.length === 0) {
      return { awardResults: [] };
    }
    const originRegion = regionForOrigin(plan.origins[0]);
    // One call per probe — regional availability covers one program each.
    for (const probe of probesFromPlan(plan)) {
      try {
        const res = await client.regionalAvailability({
          source: probe.program as never,
          origin_region: originRegion as never,
          destination_region: probe.destinationRegion as never,
          cabin: probe.cabin as never,
          start_date: plan.startDate,
          end_date: plan.endDate,
          take: 1000,
        });
        // Regional results cover a whole region; keep only our actual origins.
        const fromOurOrigins = res.data.filter((r) =>
          plan.origins.includes(r.Route.OriginAirport),
        );
        // Filter by this probe's own cabin, not the plan's flattened cabin
        // union — a business probe must not inherit an economy probe's cabin.
        collected.push(
          ...filterByCabins(normalizeResults(fromOurOrigins), [probe.cabin]),
        );
      } catch {
        // One failed probe should not sink a six-probe discovery run.
        continue;
      }
    }
  } else {
    if (plan.origins.length === 0 || plan.destinations.length === 0) {
      return { awardResults: [] };
    }
    try {
      const res = await client.search({
        origin_airport: plan.origins.join(","),
        destination_airport: plan.destinations.join(","),
        start_date: plan.startDate,
        end_date: plan.endDate,
        cabins: plan.cabins.join(","),
        sources: plan.programs.length > 0 ? plan.programs.join(",") : undefined,
        only_direct_flights: plan.nonstopOnly || undefined,
        take: 500,
        order_by: "lowest_mileage",
      });
      collected.push(
        ...filterByCabins(normalizeResults(res.data), plan.cabins),
      );
    } catch {
      return { awardResults: [] };
    }
  }

  return { awardResults: rankOptions(collected) };
}
