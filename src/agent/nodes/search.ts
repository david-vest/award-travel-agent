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
import { normalizeResults, type AwardOption, type TripSummary } from "../../tools";
import { mongoClient, DB_NAME } from "../../rag/store";
import { probesFromPlan } from "./plan-discovery";
import { AIRPORTS } from "../../tools/locations/data";
import { MULTI_CITY_CODES, countryGroup, primaryGatewayMetro, regionGroup } from "../../tools/locations/multi-city-codes";
import type { Region } from "../../tools/seats-aero/types";
import type { AgentStateType, SearchAttempt, SearchPlan } from "../state";

export const ENRICH_TOP_N = 5;
export const MAX_ROUTE_SEARCH_CALLS = 4;

type RouteAttempt = Omit<SearchAttempt, "resultCount">;

const POINT_CEILINGS: Record<string, number> = {
  economy: 90_000,
  premium: 130_000,
  business: 170_000,
  first: 250_000,
};

const TIER_ORDER: Record<NonNullable<AwardOption["searchTier"]>, number> = {
  exact: 0,
  destination_gateway: 1,
  country_pair: 2,
  region_pair: 3,
};

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

/** Filters before enrichment so scarce trip-detail calls are spent only on options the user can fund. */
export function filterByPointBalances(
  options: AwardOption[],
  plan: SearchPlan,
): AwardOption[] {
  if (!plan.filterByPointBalances) return options;
  const travelers = plan.travelers ?? 1;
  return options.filter((option) =>
    option.miles * travelers <= (plan.availablePointsByProgram?.[option.program] ?? 0),
  );
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

function attemptKey(origins: string[], destinations: string[]): string {
  return `${origins.join(",")}->${destinations.join(",")}`;
}

function airport(code: string | undefined) {
  return code ? AIRPORTS.find((item) => item.iata === code) : undefined;
}

/** Builds at most three progressively broader scopes after the exact call. */
export function buildPositioningAttempts(plan: SearchPlan): RouteAttempt[] {
  const requestedOrigin = airport(plan.origins[0]);
  const requestedDestination = airport(plan.destinations[0]);
  if (!requestedOrigin || !requestedDestination) return [];

  const originCountry = countryGroup(requestedOrigin.country);
  const destinationCountry = countryGroup(requestedDestination.country);
  const destinationGateway = primaryGatewayMetro(destinationCountry) ?? MULTI_CITY_CODES.find((group) =>
    group.kind === "metro" && group.airports.some((code) => airport(code)?.country === requestedDestination.country),
  );
  const destinationRegion = regionGroup(requestedDestination.region);
  const candidates: RouteAttempt[] = [];

  if (destinationGateway || destinationCountry) {
    candidates.push({
      tier: "destination_gateway",
      origins: plan.origins,
      destinations: [...new Set([destinationGateway?.code, destinationCountry?.code].filter((code): code is string => Boolean(code)))],
      reason: `Broadened the destination to major gateways serving ${requestedDestination.country}.`,
    });
  }
  const destinationCountryScope = destinationCountry?.code ?? destinationGateway?.code;
  if (destinationCountryScope) {
    candidates.push({
      tier: "country_pair",
      origins: originCountry ? [originCountry.code] : plan.origins,
      destinations: [destinationCountryScope],
      reason: `Searched major ${requestedOrigin.country} gateways to major ${requestedDestination.country} gateways for a positioning option.`,
    });
  }
  if (destinationRegion) {
    candidates.push({
      tier: "region_pair",
      origins: originCountry ? [originCountry.code] : plan.origins,
      destinations: [destinationRegion.code],
      reason: `Used the broadest useful gateway search into ${requestedDestination.region}.`,
    });
  }

  const exact = attemptKey(plan.origins, plan.destinations);
  const seen = new Set([exact]);
  return candidates.filter((attempt) => {
    const key = attemptKey(attempt.origins, attempt.destinations);
    if (!attempt.destinations.length || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_ROUTE_SEARCH_CALLS - 1);
}

function taxCeiling(currency: string | undefined): number {
  if (currency === "JPY") return 75_000;
  if (currency === "KRW") return 700_000;
  return 600;
}

function reasonableOption(option: AwardOption, plan: SearchPlan, trip?: TripSummary, requireDetails = false): boolean {
  if (filterByPointBalances([option], plan).length === 0) return false;
  if (option.miles > (POINT_CEILINGS[option.cabin] ?? 170_000)) return false;
  if (plan.travelers && option.remainingSeats != null && option.remainingSeats < plan.travelers) return false;
  if (requireDetails && !trip) return false;
  if (trip?.totalTaxes != null && trip.totalTaxes > taxCeiling(trip.taxesCurrency)) return false;
  if (plan.maxTaxesFeesUsd != null && trip?.totalTaxes != null && (trip.taxesCurrency ?? "USD") === "USD" && trip.totalTaxes > plan.maxTaxesFeesUsd) return false;
  if (trip?.durationMinutes != null && trip.durationMinutes > 26 * 60) return false;
  if (plan.stopPreference === "up_to_one" && trip?.stops != null && trip.stops > 1) return false;
  return true;
}

/** Exact results are broadened when none clears the value/fees/duration gate. */
export function needsPositioningSearch(state: AgentStateType): boolean {
  if (state.intent === "discovery" || state.positioningSearchComplete || !state.searchPlan) return false;
  const trips = new Map((state.tripSummaries ?? []).map((trip) => [trip.availabilityId, trip]));
  return !(state.awardResults ?? []).some((option) => reasonableOption(option, state.searchPlan!, trips.get(option.availabilityId), true));
}

async function runRouteAttempt(client: SeatsAeroClient, plan: SearchPlan, attempt: RouteAttempt): Promise<AwardOption[]> {
  const res = await client.search({
    origin_airport: attempt.origins.join(","),
    destination_airport: attempt.destinations.join(","),
    start_date: plan.startDate,
    end_date: plan.endDate,
    cabins: plan.cabins.join(","),
    sources: plan.programs.length > 0 ? plan.programs.join(",") : undefined,
    only_direct_flights: plan.nonstopOnly || undefined,
    max_fees: plan.maxTaxesFeesUsd != null ? Math.round(plan.maxTaxesFeesUsd * 100) : undefined,
    take: 500,
    order_by: "lowest_mileage",
  });
  return filterByPointBalances(filterByCabins(normalizeResults(res.data), plan.cabins), plan).map((option) => ({
    ...option,
    searchTier: attempt.tier,
    searchReason: attempt.reason,
    requestedOrigins: plan.origins,
    requestedDestinations: plan.destinations,
  }));
}

function dedupeOptions(options: AwardOption[]): AwardOption[] {
  const byOption = new Map<string, AwardOption>();
  for (const option of options) {
    const key = `${option.availabilityId}:${option.cabin}`;
    const current = byOption.get(key);
    if (!current || TIER_ORDER[option.searchTier ?? "exact"] < TIER_ORDER[current.searchTier ?? "exact"]) byOption.set(key, option);
  }
  return [...byOption.values()];
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
          max_fees: plan.maxTaxesFeesUsd != null ? Math.round(plan.maxTaxesFeesUsd * 100) : undefined,
          take: 1000,
        });
        // Regional results cover a whole region; keep only our actual origins.
        const fromOurOrigins = res.data.filter((r) =>
          plan.origins.includes(r.Route.OriginAirport),
        );
        // Filter by this probe's own cabin, not the plan's flattened cabin
        // union — a business probe must not inherit an economy probe's cabin.
        collected.push(
          ...filterByPointBalances(filterByCabins(normalizeResults(fromOurOrigins), [probe.cabin]), plan),
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
    const exact: RouteAttempt = { tier: "exact", origins: plan.origins, destinations: plan.destinations, reason: "Exact requested route." };
    try { collected.push(...await runRouteAttempt(client, plan, exact)); } catch { /* A failed exact call still allows the bounded fallback ladder. */ }
    return {
      awardResults: rankOptions(collected),
      searchAttempts: [{ ...exact, resultCount: collected.length }],
      positioningSearchComplete: false,
    };
  }

  return { awardResults: rankOptions(collected), positioningSearchComplete: true };
}

/** Runs search calls 2–4 only after exact results fail the quality gate. */
export async function searchPositioningOptions(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const plan = state.searchPlan;
  if (!plan) return { positioningSearchComplete: true };
  const client = await getClient();
  const attempts = buildPositioningAttempts(plan);
  const priorAttempts = state.searchAttempts ?? [];
  const remainingBudget = Math.max(0, MAX_ROUTE_SEARCH_CALLS - priorAttempts.length);
  const collected: AwardOption[] = [];
  const completed: SearchAttempt[] = [];

  for (const attempt of attempts.slice(0, remainingBudget)) {
    let options: AwardOption[] = [];
    try { options = await runRouteAttempt(client, plan, attempt); } catch { options = []; }
    collected.push(...options);
    completed.push({ ...attempt, resultCount: options.length });
    if (options.filter((option) => reasonableOption(option, plan)).length >= 3) break;
  }

  return {
    awardResults: rankOptions(dedupeOptions([...(state.awardResults ?? []), ...collected])),
    searchAttempts: [...priorAttempts, ...completed],
    positioningSearchComplete: true,
  };
}
