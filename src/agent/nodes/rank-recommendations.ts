import type {
  FlightRecommendation,
  RecommendationBadge,
  RecommendationConfidence,
} from "../../contracts/travel-search";
import type { CandidateAssessment } from "../../domain/candidate-assessment";
import { awardProgramForSource } from "../../domain/programs";
import { defaultRecommendationPreferences } from "../../domain/recommendation-preferences";
import type { AwardOption, TripSummary } from "../../tools";
import { optionId } from "../../rag/retriever";
import type { AgentStateType } from "../state";
import { filterByPointBalances } from "./search";
import { blendedCost } from "../points-value";

type Candidate = {
  option: AwardOption;
  trip?: TripSummary;
  carriers: string[];
  taxes?: { amount: number; currency: string };
  cost: number;
  valueScore: number;
  scheduleScore: number;
  experienceScore: number;
  overallScore: number;
  assessmentConfidence: RecommendationConfidence;
  factors: FlightRecommendation["scoreFactors"];
  badges: RecommendationBadge[];
};

function effectiveTaxes(option: AwardOption, trip?: TripSummary): { amount: number; currency: string } | undefined {
  if (trip?.totalTaxes != null) return { amount: trip.totalTaxes, currency: trip.taxesCurrency ?? "USD" };
  if (option.taxes != null) return { amount: option.taxes, currency: option.taxesCurrency ?? "USD" };
  return undefined;
}

function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return hours ? `${hours}h${remainder ? ` ${remainder}m` : ""}` : `${remainder}m`;
}

function primaryCarrier(option: AwardOption, trip?: TripSummary): string[] {
  const carriers = trip?.carriers?.length ? trip.carriers : option.airlines.split(",");
  return carriers.map((carrier) => carrier.trim().toUpperCase()).filter(Boolean);
}

function availabilityConfidence(option: AwardOption, trip?: TripSummary): RecommendationConfidence {
  if ((option.remainingSeats ?? trip?.remainingSeats) && trip?.departsAt) return "high";
  if ((option.remainingSeats ?? trip?.remainingSeats) || trip?.departsAt) return "medium";
  return "low";
}

function confidenceOrder(value: RecommendationConfidence): number {
  return { high: 2, medium: 1, low: 0 }[value];
}

function stopCount(option: AwardOption, trip?: TripSummary): number {
  if (option.direct) return 0;
  return Math.max(1, trip?.stops ?? trip?.connections?.length ?? 1);
}

function knownLayoverMinutes(trip?: TripSummary): number | undefined {
  const known = (trip?.connections ?? [])
    .map((connection) => connection.layoverMinutes)
    .filter((minutes): minutes is number => minutes != null && Number.isFinite(minutes) && minutes >= 0);
  return known.length ? known.reduce((total, minutes) => total + minutes, 0) : undefined;
}

function percentile(sorted: number[], percentileValue: number): number {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

/** Robust normalized cost score: outliers are clipped instead of flattening every useful difference. */
export function normalizedValueScores(costs: number[]): number[] {
  if (costs.length === 0) return [];
  if (costs.length === 1) return [100];
  const sorted = [...costs].sort((a, b) => a - b);
  const low = sorted[0];
  const high = costs.length >= 5 ? percentile(sorted, 0.75) : sorted.at(-1)!;
  if (high <= low) return costs.map(() => 100);
  // A two-option pool should not turn a small 5k-point difference into a
  // misleading 100-vs-0 gulf. The floor preserves meaningful absolute scale.
  const effectiveHigh = low + Math.max(high - low, 50_000);
  return costs.map((cost) => Math.round(1000 * (effectiveHigh - Math.min(effectiveHigh, Math.max(low, cost))) / (effectiveHigh - low)) / 10);
}

function localHour(value?: string): number | undefined {
  if (!value) return undefined;
  const match = value.match(/T(\d{2}):/);
  return match ? Number(match[1]) : undefined;
}

function relativeDurationScore(duration: number | undefined, durations: number[]): number {
  if (duration == null || durations.length === 0) return 50;
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  if (max === min) return 100;
  return 100 * (max - duration) / (max - min);
}

export function objectiveScheduleScore(
  trip: TripSummary | undefined,
  durations: number[],
  avoidEarlyDepartures: boolean,
  avoidLateArrivals: boolean,
): number {
  let score = relativeDurationScore(trip?.durationMinutes, durations);
  const departureHour = localHour(trip?.departsAt);
  const arrivalHour = localHour(trip?.arrivesAt);
  if (avoidEarlyDepartures && departureHour != null && departureHour < 7) score -= 25;
  if (avoidLateArrivals && arrivalHour != null && arrivalHour >= 23) score -= 25;
  return Math.max(0, Math.min(100, score));
}

function connectionScore(option: AwardOption, trip?: TripSummary): number {
  const stops = stopCount(option, trip);
  let score = 100 - stops * 25;
  for (const connection of trip?.connections ?? []) {
    if (connection.layoverMinutes != null && connection.layoverMinutes < 45) score -= 20;
    if (connection.layoverMinutes != null && connection.layoverMinutes > 240) score -= 15;
  }
  const tierPenalty = { exact: 0, destination_gateway: 30, country_pair: 45, region_pair: 60 }[option.searchTier ?? "exact"];
  return Math.max(0, score - tierPenalty);
}

function weightedAverage(entries: Array<{ score: number; weight: number }>): number {
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight === 0) return 50;
  return entries.reduce((sum, entry) => sum + entry.score * entry.weight, 0) / totalWeight;
}

function experienceScore(
  option: AwardOption,
  trip: TripSummary | undefined,
  assessment: CandidateAssessment | undefined,
  scheduleScore: number,
  state: AgentStateType,
): number {
  const preferences = state.recommendationPreferences ?? defaultRecommendationPreferences();
  const connectionWeight = Math.max(
    preferences.priorityWeights.few_connections,
    preferences.priorityWeights.connection_quality,
  );
  const entries = [
    { score: scheduleScore, weight: preferences.priorityWeights.schedule },
    { score: connectionScore(option, trip), weight: connectionWeight },
    { score: (option.remainingSeats ?? trip?.remainingSeats) != null ? 100 : 60, weight: 25 },
  ];
  const dimensionWeights = {
    cabin_product: preferences.priorityWeights.cabin_product,
    booking_ease: preferences.priorityWeights.booking_ease,
    transfer_risk: preferences.priorityWeights.low_transfer_risk,
    connection_quality: preferences.priorityWeights.connection_quality,
  } as const;
  for (const [dimension, detail] of Object.entries(assessment?.dimensions ?? {})) {
    if (!detail || !(dimension in dimensionWeights)) continue;
    entries.push({ score: detail.score, weight: dimensionWeights[dimension as keyof typeof dimensionWeights] });
  }
  let score = weightedAverage(entries);
  if ((state.searchPlan?.preferredAirlines ?? []).some((airline) => primaryCarrier(option, trip).includes(airline.toUpperCase()))) {
    score = Math.min(100, score + 5);
  }
  return Math.round(score * 10) / 10;
}

function assessmentConfidence(
  assessment: CandidateAssessment | undefined,
  trip: TripSummary | undefined,
): RecommendationConfidence {
  if (assessment?.confidence === "high" && trip?.durationMinutes != null) return "high";
  if (assessment?.confidence === "high" || assessment?.confidence === "medium" || trip?.durationMinutes != null) return "medium";
  return "low";
}

function tieBreak(a: Candidate, b: Candidate): number {
  return confidenceOrder(availabilityConfidence(b.option, b.trip)) - confidenceOrder(availabilityConfidence(a.option, a.trip))
    || Number((b.option.searchTier ?? "exact") === "exact") - Number((a.option.searchTier ?? "exact") === "exact")
    || a.cost - b.cost
    || optionId(a.option).localeCompare(optionId(b.option));
}

function tradeoffAgainst(candidate: Candidate, cheapest: Candidate): NonNullable<FlightRecommendation["tradeoff"]> | undefined {
  if (candidate === cheapest) return undefined;
  const feeDifferenceUsd = candidate.taxes?.currency === "USD" && cheapest.taxes?.currency === "USD"
    ? candidate.taxes.amount - cheapest.taxes.amount : undefined;
  const durationSavedMinutes = candidate.trip?.durationMinutes != null && cheapest.trip?.durationMinutes != null
    ? Math.max(0, cheapest.trip.durationMinutes - candidate.trip.durationMinutes) : undefined;
  const stopsSaved = Math.max(0, stopCount(cheapest.option, cheapest.trip) - stopCount(candidate.option, candidate.trip));
  return {
    comparedWithId: optionId(cheapest.option),
    extraMiles: candidate.option.miles - cheapest.option.miles,
    ...(feeDifferenceUsd != null ? { feeDifferenceUsd } : {}),
    ...(durationSavedMinutes ? { durationSavedMinutes } : {}),
    ...(stopsSaved ? { stopsSaved } : {}),
  };
}

function recommendationReason(candidate: Candidate, cheapest: Candidate, leading: boolean): string {
  const tradeoff = tradeoffAgainst(candidate, cheapest);
  if (leading && !tradeoff) return "Best overall: lowest blended cost among eligible options.";
  if (leading && tradeoff?.stopsSaved) {
    return `Best overall: saves ${tradeoff.stopsSaved} stop${tradeoff.stopsSaved === 1 ? "" : "s"} versus the lowest-cost option for ${Math.max(0, tradeoff.extraMiles).toLocaleString()} more miles.`;
  }
  if (leading && tradeoff?.durationSavedMinutes) {
    return `Best overall: saves ${formatMinutes(tradeoff.durationSavedMinutes)} versus the lowest-cost option for ${Math.max(0, tradeoff.extraMiles).toLocaleString()} more miles.`;
  }
  if (leading) return "Best overall balance of normalized value and journey experience for your selected preference.";
  if (candidate.badges.includes("best_value")) return "Lowest blended cost among eligible options.";
  if (candidate.badges.includes("best_experience")) return "Strongest combined schedule and evidence-backed experience assessment.";
  return "Eligible alternative with a different value and journey tradeoff.";
}

export async function rankRecommendations(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const plan = state.searchPlan;
  const tripByAvailability = new Map((state.tripSummaries ?? []).map((trip) => [trip.availabilityId, trip]));
  const assessableOptions = state.candidateShortlist === undefined ? state.awardResults ?? [] : state.candidateShortlist;
  const budgetEligibleOptions = plan ? filterByPointBalances(assessableOptions, plan) : assessableOptions;
  const eligible = budgetEligibleOptions.flatMap((option) => {
    const trip = tripByAvailability.get(option.availabilityId);
    const taxes = effectiveTaxes(option, trip);
    if (plan?.maxTaxesFeesUsd != null && taxes?.currency === "USD" && taxes.amount > plan.maxTaxesFeesUsd) return [];
    const seats = option.remainingSeats ?? trip?.remainingSeats;
    if (seats != null && plan?.travelers && seats < plan.travelers) return [];
    if ((plan?.nonstopOnly || plan?.stopPreference === "nonstop") && !option.direct) return [];
    if (plan?.stopPreference === "up_to_one" && stopCount(option, trip) > 1) return [];
    return [{ option, trip, taxes, cost: blendedCost(option.miles, taxes?.amount, taxes?.currency) }];
  });

  const valueScores = normalizedValueScores(eligible.map((candidate) => candidate.cost));
  const durations = eligible.flatMap((candidate) => candidate.trip?.durationMinutes != null ? [candidate.trip.durationMinutes] : []);
  const preferences = state.recommendationPreferences ?? defaultRecommendationPreferences();
  const scored: Candidate[] = eligible.map((candidate, index) => {
    const id = optionId(candidate.option);
    const assessment = state.candidateAssessments?.[id];
    const scheduleScore = objectiveScheduleScore(
      candidate.trip,
      durations,
      preferences.schedulePreferences.avoidEarlyDepartures,
      preferences.schedulePreferences.avoidLateArrivals,
    );
    const journeyScore = experienceScore(candidate.option, candidate.trip, assessment, scheduleScore, state);
    const overallScore = valueScores[index] * (1 - preferences.experienceWeight / 100)
      + journeyScore * (preferences.experienceWeight / 100);
    const factors: FlightRecommendation["scoreFactors"] = [
      { label: "Points", value: `${candidate.option.miles.toLocaleString()} miles` },
    ];
    if (candidate.taxes) factors.push({
      label: "Taxes & fees",
      value: candidate.taxes.currency === "USD" ? formatUsd(candidate.taxes.amount) : `${candidate.taxes.amount} ${candidate.taxes.currency}`,
    });
    const stops = stopCount(candidate.option, candidate.trip);
    factors.push({ label: "Stops", value: stops === 0 ? "Nonstop" : `${stops} stop${stops === 1 ? "" : "s"}` });
    const layover = knownLayoverMinutes(candidate.trip);
    if (layover != null) factors.push({ label: "Layover", value: `${formatMinutes(layover)} total` });
    if ((candidate.option.searchTier ?? "exact") !== "exact") {
      factors.push({ label: "Positioning", value: (candidate.option.searchTier ?? "exact").replaceAll("_", " ") });
    }
    const seats = candidate.option.remainingSeats ?? candidate.trip?.remainingSeats;
    if (seats != null) factors.push({ label: "Seats", value: `${seats} available` });
    factors.push(
      { label: "Value", value: `${valueScores[index].toFixed(1)}/100` },
      { label: "Experience", value: `${journeyScore.toFixed(1)}/100` },
    );
    return {
      ...candidate,
      carriers: primaryCarrier(candidate.option, candidate.trip),
      valueScore: valueScores[index],
      scheduleScore,
      experienceScore: journeyScore,
      overallScore: Math.round(overallScore * 10) / 10,
      assessmentConfidence: assessmentConfidence(assessment, candidate.trip),
      factors,
      badges: [],
    };
  });

  const bestBy = (selector: (candidate: Candidate) => number): Candidate | undefined =>
    [...scored].sort((a, b) => selector(b) - selector(a) || tieBreak(a, b))[0];
  bestBy((candidate) => candidate.valueScore)?.badges.push("best_value");
  bestBy((candidate) => candidate.experienceScore)?.badges.push("best_experience");
  bestBy((candidate) => candidate.scheduleScore)?.badges.push("best_schedule");
  scored.sort((a, b) => b.overallScore - a.overallScore || tieBreak(a, b));
  scored[0]?.badges.unshift("best_overall");
  const cheapest = [...scored].sort((a, b) => a.cost - b.cost || tieBreak(a, b))[0];

  const recommendations: FlightRecommendation[] = scored.map((candidate, index) => {
    const { option, trip, taxes } = candidate;
    const program = awardProgramForSource(option.program);
    const tier = option.searchTier ?? "exact";
    const needsPositioning = tier !== "exact";
    const before = needsPositioning && !(option.requestedOrigins ?? []).includes(option.origin)
      ? `${(option.requestedOrigins ?? []).join("/")} → ${option.origin}` : undefined;
    const after = needsPositioning && !(option.requestedDestinations ?? []).includes(option.destination)
      ? `${option.destination} → ${(option.requestedDestinations ?? []).join("/")}` : undefined;
    const assessment = state.candidateAssessments?.[optionId(option)];
    const evidenceIds = [...new Set(Object.values(assessment?.dimensions ?? {}).flatMap((detail) => detail?.evidenceIds ?? []))];
    return {
      id: optionId(option),
      rank: index + 1,
      origin: option.origin,
      destination: option.destination,
      date: option.date,
      cabin: option.cabin,
      miles: option.miles,
      taxes,
      program: { id: option.program, label: program?.name ?? option.program },
      carriers: candidate.carriers,
      direct: option.direct,
      stops: trip?.stops ?? (option.direct ? 0 : undefined),
      connections: trip?.connections,
      remainingSeats: option.remainingSeats ?? trip?.remainingSeats,
      departsAt: trip?.departsAt,
      arrivesAt: trip?.arrivesAt,
      durationMinutes: trip?.durationMinutes,
      flightNumbers: trip?.flightNumbers ?? [],
      aircraft: trip?.aircraft ?? [],
      refreshedAt: option.refreshConfirmedAt ?? option.updatedAt,
      reason: recommendationReason(candidate, cheapest, index === 0),
      scoreFactors: [...candidate.factors, { label: "Overall", value: `${candidate.overallScore.toFixed(1)}/100` }],
      confidence: availabilityConfidence(option, trip),
      valueScore: candidate.valueScore,
      experienceScore: candidate.experienceScore,
      overallScore: candidate.overallScore,
      assessmentConfidence: candidate.assessmentConfidence,
      evidenceIds,
      badges: candidate.badges,
      tradeoff: tradeoffAgainst(candidate, cheapest),
      positioning: needsPositioning ? {
        tier,
        before,
        after,
        explanation: option.searchReason ?? "This option uses a nearby gateway and requires a separate positioning segment.",
      } : undefined,
    };
  });

  const order = new Map(recommendations.map((recommendation) => [recommendation.id, recommendation.rank]));
  return {
    awardResults: [...(state.awardResults ?? assessableOptions)].sort((a, b) =>
      (order.get(optionId(a)) ?? Infinity) - (order.get(optionId(b)) ?? Infinity)),
    recommendations,
  };
}
