import { blendedCost } from "../../src/agent/points-value";
import { canonicalTripForOption } from "../../src/tools";
import { optionId } from "../../src/rag/retriever";
import type {
  RecommendationEvalOutput,
  RecommendationExpected,
  RecommendationFixture,
  RerankingEvalOutput,
  RerankingExpected,
  RerankingFixture,
} from "../recommendation-types";

type RankingArgs = {
  inputs: RecommendationFixture;
  outputs: RecommendationEvalOutput;
  referenceOutputs?: RecommendationExpected;
};

type RerankingArgs = {
  inputs: RerankingFixture;
  outputs: RerankingEvalOutput;
  referenceOutputs?: RerankingExpected;
};

type EvalResult = { key: string; score: number; comment: string };

function stopsOf(
  option: RecommendationFixture["awardResults"][number],
  fixture: RecommendationFixture,
): number {
  const trip = canonicalTripForOption(option, fixture.tripSummaries);
  return option.direct ? 0 : Math.max(1, trip?.stops ?? trip?.connections?.length ?? 1);
}

export function hardConstraintCompliance(args: RankingArgs): EvalResult {
  const plan = args.inputs.searchPlan;
  const options = new Map(args.inputs.awardResults.map((option) => [optionId(option), option]));
  const violations: string[] = [];
  for (const recommendation of args.outputs.hybrid) {
    const option = options.get(recommendation.id);
    if (!option) continue;
    const trip = canonicalTripForOption(option, args.inputs.tripSummaries);
    const seats = option.remainingSeats ?? trip?.remainingSeats;
    const taxes = trip?.totalTaxes ?? option.taxes;
    const currency = trip?.taxesCurrency ?? option.taxesCurrency ?? "USD";
    const stops = stopsOf(option, args.inputs);
    if ((plan.nonstopOnly || plan.stopPreference === "nonstop") && !option.direct) violations.push(`${recommendation.id}: not nonstop`);
    if (plan.stopPreference === "up_to_one" && stops > 1) violations.push(`${recommendation.id}: ${stops} stops`);
    if (plan.travelers && seats != null && seats < plan.travelers) violations.push(`${recommendation.id}: ${seats} seats for ${plan.travelers}`);
    if (plan.maxTaxesFeesUsd != null && taxes != null && currency === "USD" && taxes > plan.maxTaxesFeesUsd) violations.push(`${recommendation.id}: $${taxes} fees`);
    if (plan.filterByPointBalances && option.miles * (plan.travelers ?? 1) > (plan.availablePointsByProgram?.[option.program] ?? 0)) {
      violations.push(`${recommendation.id}: insufficient points balance`);
    }
    if (plan.cabins.length > 0 && !plan.cabins.includes(option.cabin)) violations.push(`${recommendation.id}: wrong cabin`);
  }
  const actual = new Set(args.outputs.hybrid.map((item) => item.id));
  const expected = new Set(args.referenceOutputs?.viableIds ?? []);
  for (const id of actual) if (!expected.has(id)) violations.push(`${id}: not fixture-viable`);
  for (const id of expected) if (!actual.has(id)) violations.push(`${id}: viable option missing`);
  return {
    key: "hard_constraint_compliance",
    score: violations.length === 0 ? 1 : 0,
    comment: violations.length === 0 ? "all and only viable options were recommended" : violations.join(" | "),
  };
}

export function recommendationIdValidity(args: RankingArgs): EvalResult {
  const candidateIds = new Set(args.inputs.awardResults.map(optionId));
  const invalid: string[] = [];
  const ranks = args.outputs.hybrid.map((item) => item.rank);
  if (new Set(ranks).size !== ranks.length || ranks.some((rank, index) => rank !== index + 1)) invalid.push("ranks are not unique and sequential");
  for (const recommendation of args.outputs.hybrid) {
    if (!candidateIds.has(recommendation.id)) invalid.push(`unknown option ${recommendation.id}`);
    const allowedEvidence = new Set((args.inputs.optionEvidence[recommendation.id] ?? []).map((doc) => doc.id));
    for (const evidenceId of recommendation.evidenceIds ?? []) {
      if (!allowedEvidence.has(evidenceId)) invalid.push(`${recommendation.id}: unknown evidence ${evidenceId}`);
    }
    for (const detail of Object.values(recommendation.qualitativeAssessments ?? {})) {
      for (const evidenceId of detail?.evidenceIds ?? []) {
        if (!allowedEvidence.has(evidenceId)) invalid.push(`${recommendation.id}: cross-option evidence ${evidenceId}`);
      }
    }
  }
  return {
    key: "recommendation_id_validity",
    score: invalid.length === 0 ? 1 : 0,
    comment: invalid.length === 0 ? "option, rank, and evidence identifiers are valid" : invalid.join(" | "),
  };
}

export function costExtremeWinner(args: RankingArgs): EvalResult {
  const winner = args.outputs.costExtreme[0]?.id;
  const expected = args.referenceOutputs?.costWinnerId;
  const viable = new Set(args.referenceOutputs?.viableIds ?? []);
  const independentlyCheapest = args.inputs.awardResults
    .filter((option) => viable.has(optionId(option)))
    .map((option) => {
      const trip = canonicalTripForOption(option, args.inputs.tripSummaries);
      return {
        id: optionId(option),
        cost: blendedCost(option.miles, trip?.totalTaxes ?? option.taxes, trip?.taxesCurrency ?? option.taxesCurrency),
      };
    })
    .sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id))[0]?.id;
  const pass = Boolean(winner && winner === expected && winner === independentlyCheapest);
  return {
    key: "cost_extreme_winner",
    score: pass ? 1 : 0,
    comment: pass ? `${winner} is the lowest viable blended-cost option` : `winner=${winner ?? "none"}; expected=${expected}; computed=${independentlyCheapest}`,
  };
}

export function hybridPreferenceWinner(args: RankingArgs): EvalResult {
  const winner = args.outputs.hybrid[0]?.id;
  const expected = args.referenceOutputs?.preferredHybridWinnerIds ?? [];
  const pass = Boolean(winner && expected.includes(winner));
  return {
    key: "hybrid_preference_winner",
    score: pass ? 1 : 0,
    comment: pass ? `${winner} matches the fixture's accepted preference-aware winners` : `winner=${winner ?? "none"}; accepted=${expected.join(",")}`,
  };
}

export function experienceWeightMonotonicity(args: RankingArgs): EvalResult {
  const lowRanks = new Map(args.outputs.costExtreme.map((item) => [item.id, item.rank]));
  const highRanks = new Map(args.outputs.journeyExtreme.map((item) => [item.id, item.rank]));
  const bestExperience = [...args.outputs.journeyExtreme]
    .sort((a, b) => (b.experienceScore ?? -Infinity) - (a.experienceScore ?? -Infinity) || a.id.localeCompare(b.id))[0];
  if (!bestExperience) return { key: "experience_weight_monotonicity", score: 0, comment: "no viable recommendations" };
  const lowRank = lowRanks.get(bestExperience.id) ?? Infinity;
  const highRank = highRanks.get(bestExperience.id) ?? Infinity;
  const pass = highRank <= lowRank;
  return {
    key: "experience_weight_monotonicity",
    score: pass ? 1 : 0,
    comment: `${bestExperience.id} moved from rank ${lowRank} to ${highRank} as experience weight increased`,
  };
}

export function sortPreservesServerRanks(args: RankingArgs): EvalResult {
  const serverRanks = new Map(args.outputs.hybrid.map((item) => [item.id, item.rank]));
  const mutations: string[] = [];
  for (const [sort, view] of Object.entries(args.outputs.sortedViews)) {
    for (const item of view) {
      if (item.rank !== serverRanks.get(item.id)) mutations.push(`${sort}:${item.id} ${serverRanks.get(item.id)}→${item.rank}`);
    }
  }
  return {
    key: "sort_rank_immutability",
    score: mutations.length === 0 ? 1 : 0,
    comment: mutations.length === 0 ? "client sorts preserved every server rank" : mutations.join(" | "),
  };
}

export function structuredAssessmentStability(args: RankingArgs): EvalResult {
  const runs = args.outputs.assessmentRuns;
  if (!args.inputs.runAssessmentStability) {
    return { key: "structured_assessment_stability", score: 1, comment: "fixture opted out of model stability sampling" };
  }
  if (args.outputs.assessmentDegraded || runs.length < 2) {
    return { key: "structured_assessment_stability", score: 0, comment: "one or more structured assessment runs degraded" };
  }
  const tolerance = args.referenceOutputs?.maxAssessmentScoreDelta ?? 15;
  const deltas: number[] = [];
  const missing: string[] = [];
  const ids = new Set(runs.flatMap((run) => Object.keys(run)));
  for (const id of ids) {
    const dimensions = new Set(runs.flatMap((run) => Object.keys(run[id]?.dimensions ?? {})));
    for (const dimension of dimensions) {
      const scores = runs.map((run) => (
        run[id]?.dimensions as Record<string, { score: number } | undefined> | undefined
      )?.[dimension]?.score);
      if (scores.some((score) => score == null)) {
        missing.push(`${id}:${dimension}`);
        continue;
      }
      deltas.push(Math.max(...scores as number[]) - Math.min(...scores as number[]));
    }
  }
  const maxDelta = deltas.length > 0 ? Math.max(...deltas) : 0;
  const pass = missing.length === 0 && maxDelta <= tolerance;
  return {
    key: "structured_assessment_stability",
    score: pass ? 1 : 0,
    comment: pass ? `maximum dimension delta ${maxDelta} (tolerance ${tolerance})` : `max delta ${maxDelta}; missing ${missing.join(", ") || "none"}`,
  };
}

export function operationalHealth(args: RankingArgs | RerankingArgs): EvalResult {
  const metrics = args.outputs.metrics;
  const pass = metrics.retrievalDegradations === 0;
  return {
    key: "operational_health",
    score: pass ? 1 : 0,
    comment: `latency=${metrics.latencyMs}ms tokens=${metrics.modelTokens} provider_calls=${metrics.providerCalls} retrieval_degradations=${metrics.retrievalDegradations}`,
  };
}

export function preferenceOnlyNoSearch(args: RerankingArgs): EvalResult {
  const expectedCalls = args.referenceOutputs?.providerCalls ?? 0;
  const pass = !args.outputs.searchRan && args.outputs.metrics.providerCalls === expectedCalls;
  return {
    key: "preference_only_no_search",
    score: pass ? 1 : 0,
    comment: `searchRan=${args.outputs.searchRan}; providerCalls=${args.outputs.metrics.providerCalls}`,
  };
}

export function rerankPreferenceFit(args: RerankingArgs): EvalResult {
  const winner = args.outputs.recommendations[0]?.id;
  const expected = args.referenceOutputs;
  const weight = args.outputs.recommendationPreferences.experienceWeight;
  const previousWeight = args.inputs.snapshot.recommendationPreferences.experienceWeight;
  const asksForLowerCost = /\b(?:cheap(?:er|est)?|lower|value first|save)\b/i.test(args.inputs.followUp);
  const asksForExperience = /\b(?:seat|cabin|experience|journey|comfort)\b/i.test(args.inputs.followUp);
  const directionFits = (!asksForLowerCost || weight < previousWeight)
    && (!asksForExperience || weight >= previousWeight);
  const pass = Boolean(expected?.winnerIds.includes(winner ?? ""))
    && weight >= (expected?.experienceWeight.min ?? 0)
    && weight <= (expected?.experienceWeight.max ?? 100)
    && directionFits;
  return {
    key: "rerank_preference_fit",
    score: pass ? 1 : 0,
    comment: `winner=${winner ?? "none"}; experienceWeight=${previousWeight}→${weight}; directionFits=${directionFits}`,
  };
}
