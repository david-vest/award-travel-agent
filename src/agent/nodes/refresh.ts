// src/agent/nodes/refresh.ts
import type { AwardOption } from "../../tools";
import type { AgentStateType, SearchPlan } from "../state";
import {
  destinationsForSearch,
  getClient,
  filterByCabins,
  prefersLowTaxes,
  rankOptions,
} from "./search";
import { lastUserText } from "./triage";
import { normalizeResults } from "../../tools";
import { resolveSeatsAeroSearchCode } from "../../tools/seats-aero/multi-city-codes";

/** Each newly-queued id costs one daily credit — keep this small. */
export const REFRESH_TOP_N = 5;
/** Matches the response-cache TTL so the two never disagree. */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
/** Above this many results the query was broad; refreshing it is not worth it. */
export const MAX_RESULTS_FOR_REFRESH = 10;

export const POLL_ATTEMPTS = 6;
export const POLL_INTERVAL_MS = 10_000;
/**
 * Only bounds when the NEXT poll iteration is attempted — checked between
 * awaits, never during one. It does NOT bound a single in-flight
 * client.refresh()/client.search() call: live.ts retries a call up to
 * maxRetries (default 3) times, each attempt with its own 20s
 * AbortSignal.timeout plus exponential backoff between attempts, so one call
 * can itself take ~60s+ worst case. A poll call that overruns this ceiling
 * plus a subsequent refetch() call with its own worst case can compound to a
 * realistic worst-case wall clock of roughly 2-3 minutes, not the ~60s this
 * constant's name suggests. Still bounded (never hangs forever, thanks to
 * live.ts's AbortSignal.timeout) — just not to this number. Tightening this
 * for real would mean threading a per-call timeout budget through the
 * SeatsAeroClient interface (client.ts, live.ts, replay.ts, and the
 * response-cache/traced decorators) — out of scope for this fix; left as a
 * known follow-up.
 */
export const POLL_CEILING_MS = 60_000;

function isStale(option: AwardOption, now: Date): boolean {
  // No timestamp means we cannot prove freshness, so treat it as stale.
  if (!option.updatedAt) return true;
  const updated = Date.parse(option.updatedAt);
  if (Number.isNaN(updated)) return true;
  return now.getTime() - updated > STALE_AFTER_MS;
}

/**
 * Refresh is a booking-intent operation, not an exploration operation. A
 * multi-airport city, a provider-native region code, or either side spanning
 * multiple values can fan out across many routes even when only a few cached
 * results happen to come back. Refresh those after the user narrows to one
 * airport pair, not during the broad first pass.
 */
export function isBroadSearchPlan(plan: SearchPlan | null | undefined): boolean {
  if (!plan) return true;
  const destinations = destinationsForSearch(
    plan.destinations,
    plan.destinationRegion,
  );
  if (plan.origins.length !== 1 || destinations.length !== 1) return true;
  return Boolean(
    resolveSeatsAeroSearchCode(plan.origins[0]) ||
      resolveSeatsAeroSearchCode(destinations[0]),
  );
}

/**
 * The gate. Three conditions, all required:
 *  - precise query only. A discovery fan-out could queue hundreds of ids.
 *  - small result set. A broad search is exploratory, not booking-intent.
 *  - actually stale. Refreshing fresh data spends nothing but proves nothing.
 */
export function shouldRefresh(
  state: AgentStateType,
  now: Date = new Date(),
): boolean {
  if (state.intent !== "route_search") return false;
  if (isBroadSearchPlan(state.searchPlan)) return false;
  const options = state.awardResults ?? [];
  if (options.length === 0) return false;
  if (options.length > MAX_RESULTS_FOR_REFRESH) return false;
  return options.some((o) => isStale(o, now));
}

export function staleOptionIds(
  options: AwardOption[],
  now: Date = new Date(),
  limit: number = REFRESH_TOP_N,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const o of options) {
    if (!isStale(o, now)) continue;
    if (seen.has(o.availabilityId)) continue;
    seen.add(o.availabilityId);
    ids.push(o.availabilityId);
    if (ids.length >= limit) break;
  }
  return ids;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Statuses that mean the provider actually vouches for the data as current —
 * either it was already fresh, or the refresh job completed and replaced it.
 * Anything else (failed, not_found, not_refreshable, skipped_outage,
 * insufficient_quota, or a job that never left queued/processing) means
 * nothing was confirmed for that id.
 */
function isConfirmed(status: string): boolean {
  return status === "fresh" || status === "succeeded";
}

/**
 * Queues a refresh, polls until it settles, then re-fetches the refreshed
 * records. Bounded by attempts AND wall clock — on timeout it returns the
 * original data untouched rather than hanging, and the answer is labeled with
 * the original (older) timestamp. See the POLL_CEILING_MS comment: the real
 * worst-case wall clock is roughly 2-3 minutes, not POLL_CEILING_MS itself,
 * because it only bounds the gap between polls, not any single in-flight call.
 */
export async function refreshAvailability(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const options = state.awardResults ?? [];
  const ids = staleOptionIds(options);
  if (ids.length === 0) return {};

  const client = await getClient();
  const deadline = Date.now() + POLL_CEILING_MS;

  try {
    let response = await client.refresh(ids);

    for (
      let attempt = 0;
      attempt < POLL_ATTEMPTS && !response.complete && Date.now() < deadline;
      attempt++
    ) {
      await sleep(POLL_INTERVAL_MS);
      if (Date.now() >= deadline) break;
      response = await client.refresh(ids);
    }

    if (!response.complete) {
      // Timed out. Keep the stale data and say nothing was re-confirmed.
      return {};
    }

    // Every item already current: nothing changed, but freshness is confirmed.
    const allFresh = response.items.every((i) => i.status === "fresh");
    if (allFresh) {
      return { refreshedAt: new Date().toISOString() };
    }

    // Nothing the provider actually vouches for (all failed, not found,
    // skipped, or quota-starved) — don't claim a re-confirmation happened.
    const anyConfirmed = response.items.some((i) => isConfirmed(i.status));
    if (!anyConfirmed) {
      return {};
    }

    return {
      awardResults: await refetch(state, ids, options),
      refreshedAt: new Date().toISOString(),
    };
  } catch {
    // Quota exhausted, cooldown, outage — proceed with what we already have.
    return {};
  }
}

/** Re-runs the original search so refreshed records replace the stale ones. */
async function refetch(
  state: AgentStateType,
  refreshedIds: string[],
  previous: AwardOption[],
): Promise<AwardOption[]> {
  const plan = state.searchPlan;
  if (!plan) return previous;

  try {
    // skipCache: true — this rebuilds the exact same search params
    // searchAwards just ran, so a cached client would hand back the same
    // (already-stale) payload instead of genuinely re-hitting the live API.
    const client = await getClient({ skipCache: true });
    const destinations = destinationsForSearch(
      plan.destinations,
      plan.destinationRegion,
    );
    const res = await client.search({
      origin_airport: plan.origins.join(","),
      destination_airport: destinations.join(","),
      start_date: plan.startDate,
      end_date: plan.endDate,
      cabins: plan.cabins.join(","),
      sources: plan.programs.length > 0 ? plan.programs.join(",") : undefined,
      only_direct_flights: plan.nonstopOnly || undefined,
      take: 500,
      order_by: "lowest_mileage",
    });

    // Same cabin enforcement searchAwards applies — normalizeResults expands
    // one record into up to 4 cabin-specific options, and availabilityId is
    // per-record, not per-cabin, so skipping this would leak every cabin
    // sharing a refreshed id back into the results.
    const updated = filterByCabins(normalizeResults(res.data), plan.cabins);
    const refreshed = new Set(refreshedIds);
    const updatedIds = new Set(updated.map((o) => o.availabilityId));

    // Replace only what we asked to refresh; leave the rest as-is so options
    // outside the top-N do not silently change under the user.
    const untouched = previous.filter((o) => !refreshed.has(o.availabilityId));
    const replacements = updated.filter((o) => refreshed.has(o.availabilityId));
    // An id we asked to refresh but that came back with no matching record
    // (sold out, expired, or the refresh failed for it specifically) — keep
    // the stale original instead of silently dropping the option.
    const missing = previous.filter(
      (o) => refreshed.has(o.availabilityId) && !updatedIds.has(o.availabilityId),
    );
    // Downstream (enrich_trips, degrade, synthesize) all assume rank order.
    return rankOptions([...replacements, ...missing, ...untouched], {
      preferLowTaxes: prefersLowTaxes(lastUserText(state)),
    });
  } catch {
    return previous;
  }
}
