import type { AwardOption, TripSummary } from "../../tools";
import { blendedCost } from "../points-value";
import type { AgentStateType, SearchPlan } from "../state";
import { filterByPointBalances } from "./search";

export const CANDIDATE_SHORTLIST_CAP = 20;

type Candidate = { option: AwardOption; trip?: TripSummary };
type Bucket = { limit: number; used: number; candidates: Candidate[] };

const TIER_ORDER: Record<NonNullable<AwardOption["searchTier"]>, number> = {
  exact: 0,
  destination_gateway: 1,
  country_pair: 2,
  region_pair: 3,
};

function optionKey(option: AwardOption): string {
  return `${option.availabilityId}:${option.cabin}`;
}

function carrierCodes(candidate: Candidate): string[] {
  const carriers = candidate.trip?.carriers?.length
    ? candidate.trip.carriers
    : candidate.option.airlines.split(",");
  return [...new Set(carriers.map((carrier) => carrier.trim().toUpperCase()).filter(Boolean))];
}

function effectiveTaxes(candidate: Candidate): { amount: number; currency: string } | undefined {
  if (candidate.trip?.totalTaxes != null) {
    return { amount: candidate.trip.totalTaxes, currency: candidate.trip.taxesCurrency ?? "USD" };
  }
  if (candidate.option.taxes != null) {
    return { amount: candidate.option.taxes, currency: candidate.option.taxesCurrency ?? "USD" };
  }
  return undefined;
}

function knownStops(candidate: Candidate): number | undefined {
  if (candidate.option.direct) return 0;
  return candidate.trip?.stops ?? candidate.trip?.connections?.length;
}

function stableCost(candidate: Candidate): number {
  const taxes = effectiveTaxes(candidate);
  return blendedCost(candidate.option.miles, taxes?.amount, taxes?.currency);
}

function stableCompare(a: Candidate, b: Candidate): number {
  return stableCost(a) - stableCost(b)
    || Number(b.option.direct) - Number(a.option.direct)
    || a.option.miles - b.option.miles
    || a.option.date.localeCompare(b.option.date)
    || a.option.program.localeCompare(b.option.program)
    || optionKey(a.option).localeCompare(optionKey(b.option));
}

function bestPerGroup(candidates: Candidate[], groupKeys: (candidate: Candidate) => string[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const candidate of [...candidates].sort(stableCompare)) {
    for (const key of groupKeys(candidate).filter(Boolean)) {
      if (!best.has(key)) best.set(key, candidate);
    }
  }
  return [...new Set(best.values())].sort(stableCompare);
}

function tripForOption(option: AwardOption, trips: TripSummary[]): TripSummary | undefined {
  const matching = trips.filter((trip) => trip.availabilityId === option.availabilityId);
  return matching.find((trip) => !trip.cabin || trip.cabin === option.cabin) ?? matching[0];
}

/** Hard eligibility is enforced before a result can spend an enrichment call. */
export function eligibleCandidates(
  options: AwardOption[],
  plan: SearchPlan | null | undefined,
  trips: TripSummary[] = [],
): Candidate[] {
  const budgetEligible = plan ? filterByPointBalances(options, plan) : options;
  const deduped = new Map<string, Candidate>();

  for (const option of budgetEligible) {
    const trip = tripForOption(option, trips);
    if (plan?.cabins.length && !plan.cabins.includes(option.cabin)) continue;
    const seats = option.remainingSeats ?? trip?.remainingSeats;
    if (seats != null && plan?.travelers && seats < plan.travelers) continue;
    if ((plan?.nonstopOnly || plan?.stopPreference === "nonstop") && !option.direct) continue;
    const stops = knownStops({ option, trip });
    if (plan?.stopPreference === "up_to_one" && stops != null && stops > 1) continue;
    const taxes = effectiveTaxes({ option, trip });
    if (
      plan?.maxTaxesFeesUsd != null
      && taxes
      && taxes.currency.toUpperCase() === "USD"
      && taxes.amount > plan.maxTaxesFeesUsd
    ) continue;

    const key = optionKey(option);
    const current = deduped.get(key);
    if (!current) {
      deduped.set(key, { option, trip });
      continue;
    }
    const currentTier = TIER_ORDER[current.option.searchTier ?? "exact"];
    const nextTier = TIER_ORDER[option.searchTier ?? "exact"];
    if (nextTier < currentTier || (nextTier === currentTier && stableCompare({ option, trip }, current) < 0)) {
      deduped.set(key, { option, trip });
    }
  }

  return [...deduped.values()].sort(stableCompare);
}

/**
 * Deterministic round-robin coverage selection. Each bucket gets its best
 * representative before a second candidate is taken from any bucket, so a
 * slightly more expensive nonstop/preferred-carrier/date/program cannot be
 * buried by a provider response ordered only by mileage.
 */
export function selectCandidateShortlist(
  options: AwardOption[],
  plan: SearchPlan | null | undefined,
  trips: TripSummary[] = [],
  cap: number = CANDIDATE_SHORTLIST_CAP,
): AwardOption[] {
  if (cap <= 0) return [];
  const candidates = eligibleCandidates(options, plan, trips);
  if (candidates.length <= cap) return candidates.map(({ option }) => option);

  const byFewestStops = [...candidates].sort((a, b) =>
    (knownStops(a) ?? Number.MAX_SAFE_INTEGER) - (knownStops(b) ?? Number.MAX_SAFE_INTEGER)
      || stableCompare(a, b));
  const preferred = candidates.filter((candidate) =>
    (plan?.preferredAirlines ?? []).some((preferredCarrier) =>
      carrierCodes(candidate).includes(preferredCarrier.toUpperCase()),
    ));
  const lowFees = candidates
    .filter((candidate) => effectiveTaxes(candidate) != null)
    .sort((a, b) => {
      const aTaxes = effectiveTaxes(a)!;
      const bTaxes = effectiveTaxes(b)!;
      if (aTaxes.currency === bTaxes.currency) return aTaxes.amount - bTaxes.amount || stableCompare(a, b);
      return stableCompare(a, b);
    });
  const byProgram = bestPerGroup(candidates, (candidate) => [candidate.option.program]);
  const byDate = bestPerGroup(candidates, (candidate) => [candidate.option.date]);
  const byTier = bestPerGroup(candidates, (candidate) => [candidate.option.searchTier ?? "exact"]);
  const byCarrierOrAircraft = bestPerGroup(candidates, (candidate) => [
    ...carrierCodes(candidate).map((carrier) => `carrier:${carrier}`),
    ...(candidate.trip?.aircraft ?? []).map((aircraft) => `aircraft:${aircraft.toUpperCase()}`),
  ]);

  const buckets: Bucket[] = [
    { limit: 6, used: 0, candidates },
    { limit: 3, used: 0, candidates: byFewestStops },
    { limit: 3, used: 0, candidates: preferred },
    { limit: 4, used: 0, candidates: byProgram },
    { limit: 4, used: 0, candidates: byDate },
    { limit: 3, used: 0, candidates: byTier },
    { limit: 3, used: 0, candidates: lowFees },
    { limit: 4, used: 0, candidates: byCarrierOrAircraft },
  ];

  const selected: Candidate[] = [];
  const selectedKeys = new Set<string>();
  let madeProgress = true;
  while (selected.length < cap && madeProgress) {
    madeProgress = false;
    for (const bucket of buckets) {
      if (selected.length >= cap || bucket.used >= bucket.limit) continue;
      const candidate = bucket.candidates.find((item) => !selectedKeys.has(optionKey(item.option)));
      if (!candidate) {
        bucket.used = bucket.limit;
        continue;
      }
      selected.push(candidate);
      selectedKeys.add(optionKey(candidate.option));
      bucket.used++;
      madeProgress = true;
    }
  }

  for (const candidate of candidates) {
    if (selected.length >= cap) break;
    if (selectedKeys.has(optionKey(candidate.option))) continue;
    selected.push(candidate);
    selectedKeys.add(optionKey(candidate.option));
  }

  return selected.map(({ option }) => option);
}

export async function buildCandidateShortlist(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  return {
    candidateShortlist: selectCandidateShortlist(
      state.awardResults ?? [],
      state.searchPlan,
      state.tripSummaries ?? [],
    ),
  };
}
