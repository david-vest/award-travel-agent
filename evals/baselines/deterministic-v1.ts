import type { AgentStateType } from "../../src/agent/state";
import { blendedCost } from "../../src/agent/points-value";
import { filterByPointBalances } from "../../src/agent/nodes/search";
import { canonicalTripForOption, type AwardOption, type TripSummary } from "../../src/tools";
import { optionId } from "../../src/rag/retriever";

const POSITIONING_PENALTY: Record<NonNullable<AwardOption["searchTier"]>, number> = {
  exact: 0,
  destination_gateway: 10_000,
  country_pair: 20_000,
  region_pair: 35_000,
};

const STOP_PENALTY = 6_000;
const LAYOVER_PENALTY_PER_HOUR = 500;
const MAX_SCORED_LAYOVER_MINUTES = 24 * 60;

function stopCount(option: AwardOption, trip?: TripSummary): number {
  if (option.direct) return 0;
  return Math.max(1, trip?.stops ?? trip?.connections?.length ?? 1);
}

function knownLayoverMinutes(trip?: TripSummary): number | undefined {
  const known = (trip?.connections ?? [])
    .map((connection) => connection.layoverMinutes)
    .filter((minutes): minutes is number => minutes != null && Number.isFinite(minutes) && minutes >= 0);
  return known.length > 0 ? known.reduce((total, minutes) => total + minutes, 0) : undefined;
}

/**
 * Frozen Phase 0 ordering used only by evals. Eligibility uses today's hard
 * constraints so the comparison isolates ranking quality instead of rewarding
 * historical safety defects.
 */
export function deterministicV1Order(state: AgentStateType): string[] {
  const plan = state.searchPlan;
  const candidates = state.candidateShortlist === undefined
    ? state.awardResults ?? []
    : state.candidateShortlist;
  const balanceEligible = plan ? filterByPointBalances(candidates, plan) : candidates;

  return balanceEligible.flatMap((option) => {
    const trip = canonicalTripForOption(option, state.tripSummaries ?? []);
    const taxesAmount = trip?.totalTaxes ?? option.taxes;
    const taxesCurrency = trip?.taxesCurrency ?? option.taxesCurrency;
    const seats = option.remainingSeats ?? trip?.remainingSeats;
    const stops = stopCount(option, trip);
    if (plan?.maxTaxesFeesUsd != null && taxesAmount != null && (taxesCurrency ?? "USD") === "USD" && taxesAmount > plan.maxTaxesFeesUsd) return [];
    if (seats != null && plan?.travelers && seats < plan.travelers) return [];
    if ((plan?.nonstopOnly || plan?.stopPreference === "nonstop") && !option.direct) return [];
    if (plan?.stopPreference === "up_to_one" && stops > 1) return [];

    let score = blendedCost(option.miles, taxesAmount, taxesCurrency);
    score += POSITIONING_PENALTY[option.searchTier ?? "exact"];
    if (option.direct) score -= plan?.stopPreference === "up_to_one" ? 4_000 : 1_500;
    else {
      score += stops * STOP_PENALTY;
      const layover = knownLayoverMinutes(trip);
      if (layover != null) {
        score += (Math.min(layover, MAX_SCORED_LAYOVER_MINUTES) / 60) * LAYOVER_PENALTY_PER_HOUR;
      }
    }
    const carriers = (trip?.carriers?.length ? trip.carriers : option.airlines.split(","))
      .map((carrier) => carrier.trim().toUpperCase());
    if ((plan?.preferredAirlines ?? []).some((airline) => carriers.includes(airline.toUpperCase()))) score -= 3_000;
    if (seats != null && plan?.travelers && seats >= plan.travelers) score -= 800;
    return [{ id: optionId(option), score, miles: option.miles }];
  }).sort((a, b) => a.score - b.score || a.miles - b.miles || a.id.localeCompare(b.id))
    .map((candidate) => candidate.id);
}
