// src/agent/nodes/search.ts
import {
  createSeatsAeroClient,
  type SeatsAeroClient,
} from "../../tools/seats-aero";
import {
  mongoCacheStore,
  withResponseCache,
  type CacheStore,
} from "../../tools/seats-aero/response-cache";
import { withTracing } from "../../tools/seats-aero/traced";
import { normalizeResults, type AwardOption } from "../../tools";
import { mongoClient, DB_NAME } from "../../rag/store";
import { probesFromPlan } from "./plan-discovery";
import { AIRPORTS } from "../../tools/locations/data";
import { MILEAGE_PROGRAMS, type Region } from "../../tools/seats-aero/types";
import {
  resolveSeatsAeroSearchCode,
  searchCodeForRegion,
} from "../../tools/seats-aero/multi-city-codes";
import type { AgentStateType } from "../state";
import { lastUserText } from "./triage";

export const ENRICH_TOP_N = 5;

type ClientParts = { inner: SeatsAeroClient; cacheStore?: CacheStore };

let partsPromise: Promise<ClientParts> | undefined;

/** Memoized so the Mongo connection and TTL index are created once, not per request. */
function getClientParts(): Promise<ClientParts> {
  if (!partsPromise) {
    partsPromise = (async () => {
      const inner = createSeatsAeroClient();
      try {
        const db = (await mongoClient()).db(DB_NAME);
        return { inner, cacheStore: await mongoCacheStore(db) };
      } catch {
        // Mongo unavailable — run uncached rather than failing the turn.
        return { inner };
      }
    })();
  }
  return partsPromise;
}

/**
 * `skipCache: true` returns a traced client with the response-cache decorator
 * left off entirely, so the call genuinely reaches the live API instead of
 * replaying whatever the last identical request wrote into the 6h cache.
 * Needed by refetch() — it deliberately re-runs the same search params the
 * original search just ran, so a cache hit would silently hand back the same
 * stale payload it was trying to refresh.
 */
export async function getClient(
  opts: { skipCache?: boolean } = {},
): Promise<SeatsAeroClient> {
  const { inner, cacheStore } = await getClientParts();
  if (opts.skipCache || !cacheStore) return withTracing(inner);
  return withTracing(withResponseCache(inner, cacheStore));
}

/** Detects when fees, rather than mileage alone, are an explicit priority. */
export function prefersLowTaxes(text: string): boolean {
  return /\b(?:low(?:est)?|minimi[sz]e|avoid|reduce|cheap(?:est)?)(?:\s+\w+){0,2}\s+(?:tax(?:es)?|fees?|surcharges?)\b|\b(?:tax(?:es)?|fees?|surcharges?)\s+(?:are\s+)?(?:low(?:est)?|minimal|cheap(?:est)?)\b/i.test(
    text,
  );
}

/**
 * Cheapest mileage first by default, with a modest nonstop bonus. When the
 * user explicitly prioritizes taxes, known tax totals come before unknown
 * ones and lower totals sort first when they use the same currency. We do not
 * compare unlike currencies without an exchange rate; mileage breaks those
 * ties instead.
 */
export function rankOptions(
  options: AwardOption[],
  opts: { preferLowTaxes?: boolean } = {},
): AwardOption[] {
  const NONSTOP_BONUS = 0.9;
  const mileageScore = (o: AwardOption) =>
    o.miles * (o.direct ? NONSTOP_BONUS : 1);

  return [...options].sort((a, b) => {
    if (opts.preferLowTaxes) {
      const aKnown = a.taxes !== undefined && Boolean(a.taxesCurrency);
      const bKnown = b.taxes !== undefined && Boolean(b.taxesCurrency);
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      if (
        aKnown &&
        bKnown &&
        a.taxesCurrency?.toUpperCase() === b.taxesCurrency?.toUpperCase() &&
        a.taxes !== b.taxes
      ) {
        return (a.taxes as number) - (b.taxes as number);
      }
    }
    return mileageScore(a) - mileageScore(b);
  });
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
  const searchCode = iata ? resolveSeatsAeroSearchCode(iata) : undefined;
  if (searchCode) return searchCode.region;
  const found = iata ? AIRPORTS.find((a) => a.iata === iata) : undefined;
  return found ? found.region : "North America";
}

function supportedPrograms(programs: string[]): string[] {
  return programs.filter((program) =>
    (MILEAGE_PROGRAMS as readonly string[]).includes(program),
  );
}

/**
 * A route plan normally has concrete destination codes. A broad region is
 * also searchable when seats.aero publishes a provider-native multi-city
 * code (for example Europe -> EUR). Keeping this fallback here makes older
 * checkpointed plans usable even if they were created before planSearch
 * started materializing that code in `destinations`.
 */
export function destinationsForSearch(
  destinations: string[],
  destinationRegion?: string,
): string[] {
  if (destinations.length > 0) return destinations;
  const code = searchCodeForRegion(destinationRegion);
  return code ? [code] : [];
}

export async function searchAwards(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const plan = state.searchPlan;
  if (!plan) {
    return { awardResults: [], searchStatus: "not_run", searchAttempts: 0 };
  }

  const collected: AwardOption[] = [];
  let attempts = 0;
  let successfulCalls = 0;

  if (state.intent === "discovery") {
    const probes = probesFromPlan(plan);
    if (plan.origins.length === 0 || probes.length === 0) {
      return { awardResults: [], searchStatus: "not_run", searchAttempts: 0 };
    }
    const client = await getClient();
    const originRegion = regionForOrigin(plan.origins[0]);
    // One call per probe — regional availability covers one program each.
    for (const probe of probes) {
      attempts++;
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
        successfulCalls++;
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
    const destinations = destinationsForSearch(
      plan.destinations,
      plan.destinationRegion,
    );
    if (plan.origins.length === 0 || destinations.length === 0) {
      return { awardResults: [], searchStatus: "not_run", searchAttempts: 0 };
    }

    const client = await getClient();
    const programs = supportedPrograms(plan.programs);
    attempts++;
    try {
      const res = await client.search({
        origin_airport: plan.origins.join(","),
        destination_airport: destinations.join(","),
        start_date: plan.startDate,
        end_date: plan.endDate,
        cabins: plan.cabins.join(","),
        // Empty means comprehensive. A non-empty list is an explicit user
        // constraint, not a planner guess (see PLAN_SEARCH_PROMPT).
        sources: programs.length > 0 ? programs.join(",") : undefined,
        only_direct_flights: plan.nonstopOnly || undefined,
        take: 500,
        order_by: "lowest_mileage",
      });
      successfulCalls++;
      collected.push(
        ...filterByCabins(normalizeResults(res.data), plan.cabins),
      );
    } catch {
      // LiveSeatsAeroClient already retries network/429 failures internally.
      // Repeating the identical cached query here cannot improve coverage.
    }
  }

  return {
    awardResults: rankOptions(collected, {
      preferLowTaxes: prefersLowTaxes(lastUserText(state)),
    }),
    searchStatus: successfulCalls > 0 ? "searched" : "provider_error",
    searchAttempts: attempts,
  };
}
